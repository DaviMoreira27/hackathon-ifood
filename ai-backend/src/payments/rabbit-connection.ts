import type { Logger } from '@nestjs/common';
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { describeError } from '../common/describe-error.js';

export interface RabbitConnectionOptions {
  url: string;
  // Declara a topologia e começa a consumir no canal recém-aberto (a cada reconexão).
  setup: (channel: ConfirmChannel) => Promise<void>;
}

// Conexão com o RabbitMQ que se mantém sozinha: conecta em segundo plano (o app sobe mesmo com o
// RabbitMQ fora), reconecta com backoff quando cai e, ao parar, espera o que já está sendo
// processado (o resto fica na fila, sem ack).
export class RabbitConnection {
  private connection: ChannelModel | null = null;
  private current: ConfirmChannel | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly options: RabbitConnectionOptions,
    private readonly logger: Logger,
  ) {}

  get channel(): ConfirmChannel | null {
    return this.current;
  }

  start(): void {
    this.loopDone = this.run(); // não bloqueia o boot
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    const channel = this.current;
    this.current = null;
    await channel?.close().catch(() => undefined);
    await Promise.race([
      Promise.allSettled(this.inFlight),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    await this.connection?.close().catch(() => undefined);
    this.connection = null;
    await this.loopDone;
  }

  // Trabalho em andamento numa mensagem: stop() espera por ele.
  track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private async run(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const { closed } = await this.connect();
        backoff = 1000;
        await closed; // fica aqui enquanto a conexão estiver de pé
        if (!this.stopped)
          this.logger.warn('Conexão com o RabbitMQ caiu; reconectando...');
      } catch (err) {
        if (this.stopped) break;
        this.logger.warn(
          `Sem conexão com o RabbitMQ (nova tentativa em ${backoff}ms): ${describeError(err)}`,
        );
        await this.cleanup();
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 15_000);
        continue;
      }
      await this.cleanup();
      if (!this.stopped) await this.sleep(1000);
    }
  }

  // Conecta e chama o setup. `closed` resolve quando a conexão fechar (num objeto: devolver a
  // promise direto faria o await esperar a conexão cair).
  private async connect(): Promise<{ closed: Promise<void> }> {
    const connection = await amqp.connect(this.options.url);
    // Sem listener de 'error', um erro de conexão derrubaria o processo.
    connection.on('error', (err: Error) =>
      this.logger.warn(`Conexão com o RabbitMQ: ${err.message}`),
    );
    const closed = new Promise<void>((resolve) =>
      connection.once('close', () => resolve()),
    );

    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', (err: Error) =>
        this.logger.warn(`Canal do RabbitMQ: ${err.message}`),
      );
      await this.options.setup(channel);
      this.connection = connection;
      this.current = channel;
      return { closed };
    } catch (err) {
      await connection.close().catch(() => undefined);
      throw err;
    }
  }

  private async cleanup(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.current = null;
    await connection?.close().catch(() => undefined);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
