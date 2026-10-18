import { InvalidEventError, parseEvent } from './payment-event.parser.js';

const parse = (value: unknown) =>
  parseEvent(Buffer.from(JSON.stringify(value)));

describe('payment-event.parser', () => {
  it('erros de formato são definitivos (InvalidEventError)', () => {
    expect(() => parse({})).toThrow(InvalidEventError);
    expect(() => parseEvent(Buffer.from('{'))).toThrow(InvalidEventError);
  });
});
