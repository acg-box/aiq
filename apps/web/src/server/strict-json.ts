export class DuplicateJsonKeyError extends SyntaxError {
  constructor() {
    super('The JSON body contains a duplicate object key.');
    this.name = 'DuplicateJsonKeyError';
  }
}

const MAX_JSON_CONTAINER_DEPTH = 32;

class JsonScanner {
  readonly #source: string;
  #position = 0;
  #depth = 0;

  constructor(source: string) {
    this.#source = source;
  }

  scan(): void {
    this.#skipWhitespace();
    this.#value();
    this.#skipWhitespace();
    if (this.#position !== this.#source.length) {
      throw new SyntaxError('Unexpected data after the JSON value.');
    }
  }

  #value(): void {
    this.#skipWhitespace();
    const character = this.#source[this.#position];
    if (character === '{') {
      this.#object();
    } else if (character === '[') {
      this.#array();
    } else if (character === '"') {
      this.#string();
    } else if (character === 't') {
      this.#literal('true');
    } else if (character === 'f') {
      this.#literal('false');
    } else if (character === 'n') {
      this.#literal('null');
    } else {
      this.#number();
    }
  }

  #object(): void {
    this.#enterContainer('{');
    const keys = new Set<string>();
    this.#skipWhitespace();
    if (this.#consume('}')) {
      this.#leaveContainer();
      return;
    }
    while (true) {
      this.#skipWhitespace();
      if (this.#source[this.#position] !== '"') {
        throw new SyntaxError('JSON object keys must be strings.');
      }
      const key = this.#string();
      if (keys.has(key)) {
        throw new DuplicateJsonKeyError();
      }
      keys.add(key);
      this.#skipWhitespace();
      this.#expect(':');
      this.#value();
      this.#skipWhitespace();
      if (this.#consume('}')) {
        this.#leaveContainer();
        return;
      }
      this.#expect(',');
    }
  }

  #array(): void {
    this.#enterContainer('[');
    this.#skipWhitespace();
    if (this.#consume(']')) {
      this.#leaveContainer();
      return;
    }
    while (true) {
      this.#value();
      this.#skipWhitespace();
      if (this.#consume(']')) {
        this.#leaveContainer();
        return;
      }
      this.#expect(',');
    }
  }

  #string(): string {
    const start = this.#position;
    this.#expect('"');
    while (this.#position < this.#source.length) {
      const character = this.#source[this.#position];
      if (character === '"') {
        this.#position += 1;
        const decoded: unknown = JSON.parse(this.#source.slice(start, this.#position));
        if (typeof decoded !== 'string' || !decoded.isWellFormed()) {
          throw new SyntaxError('JSON strings must contain valid Unicode scalar values.');
        }
        return decoded;
      }
      if (character === '\\') {
        this.#position += 1;
        const escape = this.#source[this.#position];
        if (escape === 'u') {
          const codePoint = this.#source.slice(this.#position + 1, this.#position + 5);
          if (!/^[0-9a-fA-F]{4}(?![\s\S])/.test(codePoint)) {
            throw new SyntaxError('Invalid JSON Unicode escape.');
          }
          this.#position += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) {
          throw new SyntaxError('Invalid JSON string escape.');
        }
        this.#position += 1;
        continue;
      }
      if (!character || character.charCodeAt(0) <= 0x1f) {
        throw new SyntaxError('Invalid JSON string character.');
      }
      this.#position += 1;
    }
    throw new SyntaxError('Unterminated JSON string.');
  }

  #number(): void {
    const remaining = this.#source.slice(this.#position);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remaining);
    if (!match) {
      throw new SyntaxError('Invalid JSON value.');
    }
    this.#position += match[0].length;
  }

  #literal(value: string): void {
    if (!this.#source.startsWith(value, this.#position)) {
      throw new SyntaxError('Invalid JSON literal.');
    }
    this.#position += value.length;
  }

  #skipWhitespace(): void {
    while (' \t\r\n'.includes(this.#source[this.#position] ?? '\0')) {
      this.#position += 1;
    }
  }

  #enterContainer(character: '{' | '['): void {
    this.#expect(character);
    this.#depth += 1;
    if (this.#depth > MAX_JSON_CONTAINER_DEPTH) {
      throw new SyntaxError('JSON nesting is too deep to parse safely.');
    }
  }

  #leaveContainer(): void {
    this.#depth -= 1;
  }

  #consume(character: string): boolean {
    if (this.#source[this.#position] !== character) {
      return false;
    }
    this.#position += 1;
    return true;
  }

  #expect(character: string): void {
    if (!this.#consume(character)) {
      throw new SyntaxError(`Expected ${character}.`);
    }
  }
}

export function parseJsonWithoutDuplicateKeys(source: string): unknown {
  new JsonScanner(source).scan();
  return JSON.parse(source);
}
