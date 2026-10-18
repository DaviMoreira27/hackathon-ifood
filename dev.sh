#!/usr/bin/env bash
# Sobe (e derruba) o ambiente local inteiro, tudo neste computador:
#   Postgres + RabbitMQ (containers) → migrações do banco → mock do iFood → ai-backend
#
#   ./dev.sh up              sobe o que não estiver no ar (pode rodar quantas vezes quiser)
#   ./dev.sh down            para os backends e os containers (os dados do banco ficam)
#   ./dev.sh status          mostra o que está no ar
#   ./dev.sh logs [serviço]  acompanha os logs (ai-backend | ifood-backend; sem argumento, os dois)
#   ./dev.sh migrate         só roda as migrações pendentes (os containers precisam estar no ar)
#   ./dev.sh restart         reinicia os dois backends
#   ./dev.sh reset --yes     APAGA containers e volumes (banco e filas) e recomeça do zero
#
# Variáveis opcionais: CONTAINER_ENGINE (docker|podman), AI_BACKEND_PORT (3000), MOCK_PORT (3001).
# O front do pagador não é iniciado aqui: o link de pagamento aponta para PAYMENT_LINK_TEMPLATE.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.dev"
AI_DIR="$ROOT/ai-backend"
MOCK_DIR="$ROOT/ifood-backend"

PG_CONTAINER="ifood-postgres"
RABBIT_CONTAINER="ifood-rabbitmq"
PG_PORT=5433
AMQP_PORT=5672
RABBIT_UI_PORT=15672

# ───────────────────────── utilidades ─────────────────────────

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''
fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%saviso:%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%serro:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "'$1' não encontrado no PATH"; }

# Algo aceita conexões nessa porta? (bash puro, sem ss/lsof)
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

wait_for() { # descrição segundos comando...
  local desc=$1 timeout=$2 i
  shift 2
  for ((i = 0; i < timeout; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "$desc não ficou pronto em ${timeout}s"
}

# Valor de uma variável: ambiente do processo primeiro (é o que o dotenv dos backends respeita),
# senão a linha KEY=... do arquivo .env.
env_value() { # KEY ARQUIVO
  local key=$1 file=$2 value
  value="${!key-}"
  if [ -n "$value" ]; then printf '%s' "$value"; return 0; fi
  [ -f "$file" ] || return 0
  value="$( (grep -E "^[[:space:]]*${key}=" "$file" || true) | tail -n 1 | cut -d= -f2-)"
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

is_placeholder() { [ -z "$1" ] || [[ "$1" == *SEU_* ]]; }

# ───────────────────────── container engine ─────────────────────────

ENGINE=""
detect_engine() {
  ENGINE="${CONTAINER_ENGINE:-}"
  if [ -z "$ENGINE" ]; then
    local candidate
    for candidate in docker podman; do
      if command -v "$candidate" >/dev/null 2>&1; then ENGINE="$candidate"; break; fi
    done
  fi
  [ -n "$ENGINE" ] || die "nem docker nem podman encontrados. Instale um deles."
  "$ENGINE" info >/dev/null 2>&1 || die "'$ENGINE' está instalado mas não responde (o serviço está rodando?)"
  export CONTAINER_ENGINE="$ENGINE"
}

container_exists()  { "$ENGINE" container inspect "$1" >/dev/null 2>&1; }
container_running() { [ "$("$ENGINE" container inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }

# Se já existe um volume criado pelo docker compose deste projeto, usa o mesmo (não esconde dados
# que você já tenha); senão cria um volume próprio.
volume_name() { # nome lógico
  if "$ENGINE" volume inspect "ai-backend_$1" >/dev/null 2>&1; then
    printf 'ai-backend_%s' "$1"
  else
    printf 'ifood-%s' "$1"
  fi
}

ensure_container() { # nome portas... -- argumentos do run
  local name=$1 port
  shift
  local ports=()
  while [ "$1" != "--" ]; do ports+=("$1"); shift; done
  shift
  if container_running "$name"; then
    say "  $name já está rodando"
    return 0
  fi
  for port in "${ports[@]}"; do
    if port_in_use "$port"; then
      die "a porta $port está ocupada por outro processo; $name não consegue subir. Libere a porta e tente de novo."
    fi
  done
  if container_exists "$name"; then
    say "  iniciando $name"
    "$ENGINE" start "$name" >/dev/null
  else
    say "  criando $name"
    "$ENGINE" run -d --name "$name" "$@" >/dev/null
  fi
}

pg_ready()     { "$ENGINE" exec "$PG_CONTAINER" pg_isready -h 127.0.0.1 -U ifood -q; }
# -u rabbitmq é essencial: como root, o comando cria o .erlang.cookie com dono root enquanto o servidor
# ainda está subindo, e o servidor (usuário rabbitmq) morre com "eacces" ao tentar lê-lo.
rabbit_ready() { "$ENGINE" exec -u rabbitmq "$RABBIT_CONTAINER" rabbitmq-diagnostics -q ping; }

# Mesma configuração de ai-backend/docker-compose.yml (que continua valendo para quem prefere compose).
start_infra() {
  step "Infraestrutura (Postgres e RabbitMQ) com $ENGINE"
  ensure_container "$PG_CONTAINER" "$PG_PORT" -- \
    -e POSTGRES_USER=ifood -e POSTGRES_PASSWORD=ifood -e POSTGRES_DB=ifood \
    -p "$PG_PORT:5432" \
    -v "$(volume_name pgdata):/var/lib/postgresql/data" \
    docker.io/library/postgres:16
  # hostname fixo: o RabbitMQ guarda os dados por nome de nó, e sem isso um container recriado
  # não enxerga as filas do volume.
  ensure_container "$RABBIT_CONTAINER" "$AMQP_PORT" "$RABBIT_UI_PORT" -- \
    --hostname ifood-rabbitmq \
    -e RABBITMQ_DEFAULT_USER=ifood -e RABBITMQ_DEFAULT_PASS=ifood \
    -p "$AMQP_PORT:5672" -p "$RABBIT_UI_PORT:15672" \
    -v "$(volume_name rabbitdata):/var/lib/rabbitmq" \
    docker.io/library/rabbitmq:3-management
  say "  aguardando o Postgres..."
  wait_for "o Postgres" 90 pg_ready
  say "  aguardando o RabbitMQ..."
  wait_for "o RabbitMQ" 120 rabbit_ready
}

# ───────────────────────── configuração ─────────────────────────

# Chave AES-256 que cifra os tokens do iFood no banco. Gerada uma vez e guardada no .env: se for
# perdida ou trocada, os tokens guardados deixam de decifrar e cada usuário só precisa logar de novo.
ensure_encryption_key() { # arquivo .env
  local file=$1 key
  [ -z "$(env_value TOKEN_ENCRYPTION_KEY "$file")" ] || return 0
  key="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
  if grep -qE '^TOKEN_ENCRYPTION_KEY=' "$file"; then
    sed -i "s|^TOKEN_ENCRYPTION_KEY=.*|TOKEN_ENCRYPTION_KEY=$key|" "$file"
  else
    printf '\n# Chave que cifra os tokens do iFood no banco (AES-256). Não perca nem troque: quem trocar precisa logar de novo.\nTOKEN_ENCRYPTION_KEY=%s\n' "$key" >>"$file"
  fi
  say "  gerei TOKEN_ENCRYPTION_KEY e salvei em ai-backend/.env (guarde uma cópia)"
}

# Grava no .env uma variável que o próprio script define (a infra tem credenciais e portas fixas),
# só se ela ainda não existir, para você ver no arquivo onde o banco está.
ensure_env_var() { # arquivo CHAVE valor comentário
  local file=$1 key=$2 value=$3 comment=$4
  [ -z "$(env_value "$key" "$file")" ] || return 0
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n# %s\n%s=%s\n' "$comment" "$key" "$value" >>"$file"
  fi
  say "  adicionei $key ao ai-backend/.env"
}

validate_env() {
  step "Configuração (.env)"
  local env_file="$AI_DIR/.env"
  if [ ! -f "$env_file" ]; then
    cp "$AI_DIR/.env.example" "$env_file"
    die "criei ai-backend/.env a partir do exemplo. Preencha TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, IFOOD_CLIENT_ID e IFOOD_CLIENT_SECRET e rode ./dev.sh up de novo."
  fi
  is_placeholder "$(env_value TELEGRAM_BOT_TOKEN "$env_file")" &&
    die "TELEGRAM_BOT_TOKEN não está definido em ai-backend/.env (o bot não sobe sem ele)."
  local key
  for key in ANTHROPIC_API_KEY IFOOD_CLIENT_ID IFOOD_CLIENT_SECRET; do
    if is_placeholder "$(env_value "$key" "$env_file")"; then
      warn "$key não está definido em ai-backend/.env (o bot sobe, mas essa parte não vai funcionar)"
    fi
  done

  ensure_encryption_key "$env_file"
  ensure_env_var "$env_file" DATABASE_URL "postgresql://ifood:ifood@localhost:$PG_PORT/ifood" \
    "Postgres do ./dev.sh (usuário ifood, senha ifood, porta $PG_PORT)"
  ensure_env_var "$env_file" RABBITMQ_URL "amqp://ifood:ifood@localhost:$AMQP_PORT" \
    "RabbitMQ do ./dev.sh (eventos de pagamento)"

  if [ ! -f "$MOCK_DIR/.env" ]; then
    cp "$MOCK_DIR/.env.example" "$MOCK_DIR/.env"
    say "  criei ifood-backend/.env a partir do exemplo"
  fi
  # A chave que o ai-backend usa para falar com o mock precisa ser a mesma que o mock espera.
  local mock_key ai_key
  mock_key="$(env_value MOCK_API_KEY "$MOCK_DIR/.env")"
  ai_key="$(env_value PAYMENTS_API_KEY "$env_file")"
  if [ "${mock_key:-dev-mock-key}" != "${ai_key:-dev-mock-key}" ]; then
    warn "MOCK_API_KEY (ifood-backend) é diferente de PAYMENTS_API_KEY (ai-backend): o ai-backend vai levar 401 ao criar cobranças"
  fi
}

ensure_deps() { # diretório
  local dir=$1 name
  name="$(basename "$dir")"
  if [ ! -d "$dir/node_modules" ] || [ "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]; then
    step "Instalando dependências de $name"
    (cd "$dir" && npm ci --no-audit --no-fund) || die "npm ci falhou em $name"
  fi
}

service_port() { # serviço
  case "$1" in
    ai-backend)
      if [ -n "${AI_BACKEND_PORT:-}" ]; then printf '%s' "$AI_BACKEND_PORT"; return; fi
      local from_env
      from_env="$(env_value PORT "$AI_DIR/.env")"
      printf '%s' "${from_env:-3000}"
      ;;
    ifood-backend) printf '%s' "${MOCK_PORT:-3001}" ;;
  esac
}

service_dir() { case "$1" in ai-backend) printf '%s' "$AI_DIR" ;; ifood-backend) printf '%s' "$MOCK_DIR" ;; esac; }

# ───────────────────────── serviços (processos) ─────────────────────────

pid_file() { printf '%s/%s.pid' "$RUN_DIR" "$1"; }
log_file() { printf '%s/%s.log' "$RUN_DIR" "$1"; }

service_pid() { # serviço → imprime o pid se estiver vivo
  local file pid
  file="$(pid_file "$1")"
  [ -f "$file" ] || return 1
  pid="$(cat "$file")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then printf '%s' "$pid"; return 0; fi
  return 1
}

http_ok() { curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$1/"; }

start_service() { # serviço
  local name=$1 dir port pid log i
  dir="$(service_dir "$name")"
  port="$(service_port "$name")"
  log="$(log_file "$name")"

  if pid="$(service_pid "$name")"; then
    say "  $name já está rodando (pid $pid, porta $port)"
    return 0
  fi
  if port_in_use "$port"; then
    local port_var=AI_BACKEND_PORT
    [ "$name" = "ifood-backend" ] && port_var=MOCK_PORT
    die "a porta $port (necessária para $name) já está em uso por outro processo. Libere-a ou rode com $port_var=<outra porta>."
  fi

  mkdir -p "$RUN_DIR"
  : >"$log"
  # setsid: o serviço vira líder de um grupo de processos próprio, para o down matar a árvore toda
  # (npm → nest → node). PORT no ambiente vence o do .env (o dotenv não sobrescreve).
  (
    cd "$dir"
    PORT="$port" setsid npm run start:dev >>"$log" 2>&1 </dev/null &
    echo $! >"$(pid_file "$name")"
  )
  pid="$(cat "$(pid_file "$name")")"
  say "  $name iniciado (pid $pid); compilando..."

  for ((i = 0; i < 240; i++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$(pid_file "$name")"
      say "---- últimas linhas de $log ----" >&2
      tail -n 25 "$log" >&2 || true
      die "$name encerrou durante a inicialização"
    fi
    if http_ok "$port"; then
      say "  $name no ar em http://localhost:$port"
      return 0
    fi
    sleep 1
  done
  tail -n 25 "$log" >&2 || true
  die "$name não respondeu em http://localhost:$port em 240s (veja $log)"
}

stop_service() { # serviço
  local name=$1 pid pgid i
  if ! pid="$(service_pid "$name")"; then
    rm -f "$(pid_file "$name")"
    say "  $name não está rodando"
    return 0
  fi
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  say "  parando $name (pid $pid)"
  # Só mata o grupo inteiro se o serviço realmente é o líder dele (foi iniciado por este script).
  if [ "$pgid" = "$pid" ]; then kill -TERM -- "-$pid" 2>/dev/null || true; else kill -TERM "$pid" 2>/dev/null || true; fi
  for ((i = 0; i < 30; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    if [ "$pgid" = "$pid" ]; then kill -KILL -- "-$pid" 2>/dev/null || true; else kill -KILL "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$(pid_file "$name")"
}

# ───────────────────────── comandos ─────────────────────────

cmd_up() {
  need_cmd node; need_cmd npm; need_cmd curl; need_cmd setsid
  detect_engine
  validate_env
  # Não mexe em node_modules de um serviço que já está rodando.
  service_pid ai-backend >/dev/null || ensure_deps "$AI_DIR"
  service_pid ifood-backend >/dev/null || ensure_deps "$MOCK_DIR"
  start_infra
  step "Banco de dados"
  "$AI_DIR/db/migrate.sh" apply
  step "Backends"
  # O mock primeiro: ele declara a fila de eventos, então nada publicado se perde.
  start_service ifood-backend
  start_service ai-backend
  print_summary
}

print_summary() {
  local template
  template="$(env_value PAYMENT_LINK_TEMPLATE "$AI_DIR/.env")"
  step "Tudo no ar"
  say "  ai-backend      http://localhost:$(service_port ai-backend)  (Telegram, agente, OAuth, consumidor de eventos)"
  say "  ifood-backend   http://localhost:$(service_port ifood-backend)  (mock do iFood: cobranças e eventos de pagamento)"
  say "  RabbitMQ        http://localhost:$RABBIT_UI_PORT  (painel; usuário ifood / senha ifood)"
  say "  Postgres        localhost:$PG_PORT  (usuário ifood / senha ifood / banco ifood)"
  say "  link de pagamento enviado no Telegram: ${template:-http://localhost:5173/pay/{token}}"
  say "${C_DIM}  logs: ./dev.sh logs    parar: ./dev.sh down    estado: ./dev.sh status${C_RESET}"
}

cmd_down() {
  step "Parando backends"
  stop_service ai-backend
  stop_service ifood-backend
  if detect_engine_quiet; then
    step "Parando containers (os dados continuam nos volumes)"
    local name
    for name in "$RABBIT_CONTAINER" "$PG_CONTAINER"; do
      if container_running "$name"; then
        say "  parando $name"
        "$ENGINE" stop "$name" >/dev/null
      else
        say "  $name não está rodando"
      fi
    done
  fi
}

detect_engine_quiet() { (detect_engine) >/dev/null 2>&1 && detect_engine; }

cmd_status() {
  local name pid port state
  if detect_engine_quiet; then
    say "Containers ($ENGINE):"
    for name in "$PG_CONTAINER" "$RABBIT_CONTAINER"; do
      if container_running "$name"; then state="${C_GREEN}rodando${C_RESET}"
      elif container_exists "$name"; then state="${C_YELLOW}parado${C_RESET}"
      else state="não existe"; fi
      printf '  %-18s %s\n' "$name" "$state"
    done
  else
    say "Containers: nenhum docker/podman utilizável"
  fi
  say "Serviços:"
  for name in ifood-backend ai-backend; do
    port="$(service_port "$name")"
    if pid="$(service_pid "$name")"; then
      if http_ok "$port"; then state="${C_GREEN}no ar${C_RESET} (pid $pid)"; else state="${C_YELLOW}iniciando/sem resposta${C_RESET} (pid $pid)"; fi
    elif port_in_use "$port"; then state="${C_YELLOW}porta $port ocupada por outro processo${C_RESET}"
    else state="parado"; fi
    printf '  %-18s %-6s %s\n' "$name" ":$port" "$state"
  done
  if detect_engine_quiet && container_running "$PG_CONTAINER"; then
    say "Migrações:"
    "$AI_DIR/db/migrate.sh" status | sed 's/^/  /'
  fi
}

cmd_logs() {
  local target="${1:-}"
  case "$target" in
    "") [ -d "$RUN_DIR" ] && ls "$RUN_DIR"/*.log >/dev/null 2>&1 || die "ainda não há logs (rode ./dev.sh up)"
        exec tail -n 40 -f "$RUN_DIR"/*.log ;;
    ai-backend|ifood-backend)
        [ -f "$(log_file "$target")" ] || die "ainda não há log de $target"
        exec tail -n 80 -f "$(log_file "$target")" ;;
    *) die "serviço desconhecido: $target (use ai-backend ou ifood-backend)" ;;
  esac
}

cmd_migrate() {
  detect_engine
  "$AI_DIR/db/migrate.sh" apply
}

cmd_restart() {
  need_cmd node; need_cmd npm; need_cmd curl; need_cmd setsid
  step "Reiniciando backends"
  stop_service ai-backend
  stop_service ifood-backend
  start_service ifood-backend
  start_service ai-backend
}

cmd_reset() {
  [ "${1:-}" = "--yes" ] || die "reset APAGA containers e volumes (banco e filas). Rode ./dev.sh reset --yes se é isso mesmo."
  detect_engine
  cmd_down
  step "Apagando containers e volumes"
  local name vol
  for name in "$RABBIT_CONTAINER" "$PG_CONTAINER"; do
    if container_exists "$name"; then "$ENGINE" rm -f "$name" >/dev/null && say "  removido $name"; fi
  done
  for vol in "$(volume_name pgdata)" "$(volume_name rabbitdata)"; do
    if "$ENGINE" volume inspect "$vol" >/dev/null 2>&1; then "$ENGINE" volume rm "$vol" >/dev/null && say "  removido volume $vol"; fi
  done
  rm -rf "$RUN_DIR"
  say "Pronto. ./dev.sh up recria tudo do zero."
}

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

main() {
  case "${1:-help}" in
    up) cmd_up ;;
    down|stop) cmd_down ;;
    status) cmd_status ;;
    logs) cmd_logs "${2:-}" ;;
    migrate) cmd_migrate ;;
    restart) cmd_restart ;;
    reset) cmd_reset "${2:-}" ;;
    help|-h|--help) usage ;;
    *) usage >&2; exit 2 ;;
  esac
}

# Permite "source dev.sh" nos testes sem executar nada.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then main "$@"; fi
