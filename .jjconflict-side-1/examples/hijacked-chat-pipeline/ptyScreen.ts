/**
 * Small VT screen model for turning a native agent PTY byte stream into a
 * readable chat bubble. It intentionally models display state, not ANSI style.
 */
export class PtyScreen {
  readonly cols: number;
  readonly rows: number;
  readonly maxScrollback: number;

  private grid: string[][];
  private history: string[] = [];
  private row = 0;
  private col = 0;
  private savedRow = 0;
  private savedCol = 0;
  private pending = "";

  constructor(cols = 100, rows = 32, maxScrollback = 240) {
    this.cols = Math.max(2, Math.floor(cols) || 100);
    this.rows = Math.max(2, Math.floor(rows) || 32);
    this.maxScrollback = Math.max(0, Math.floor(maxScrollback) || 0);
    this.grid = Array.from({ length: this.rows }, () => this.blankRow());
  }

  feed(chunk: string): void {
    const input = this.pending + chunk;
    this.pending = "";
    let index = 0;

    while (index < input.length) {
      const character = input[index]!;
      if (character === "\x1b") {
        const consumed = this.consumeEscape(input, index);
        if (consumed === null) {
          this.pending = input.slice(index);
          break;
        }
        index = consumed;
        continue;
      }
      if (character === "\r") {
        this.col = 0;
        index += 1;
        continue;
      }
      if (character === "\n") {
        this.lineFeed();
        index += 1;
        continue;
      }
      if (character === "\b") {
        this.col = Math.max(0, this.col - 1);
        index += 1;
        continue;
      }
      if (character === "\t") {
        this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        index += 1;
        continue;
      }

      const codePoint = input.codePointAt(index) ?? 0;
      if (codePoint < 32 || codePoint === 127) {
        index += codePoint > 0xffff ? 2 : 1;
        continue;
      }
      const printable = String.fromCodePoint(codePoint);
      if (this.col >= this.cols) {
        this.col = 0;
        this.lineFeed();
      }
      this.grid[this.row]![this.col] = printable;
      this.col += 1;
      index += codePoint > 0xffff ? 2 : 1;
    }
  }

  snapshot(maxLines = this.maxScrollback + this.rows): string {
    const lines = [...this.history, ...this.grid.map((line) => this.trimLine(line))];
    while (lines.length && lines[0] === "") lines.shift();
    while (lines.length && lines.at(-1) === "") lines.pop();
    return lines.slice(-Math.max(1, maxLines)).join("\n");
  }

  private blankRow(): string[] {
    return Array(this.cols).fill(" ");
  }

  private trimLine(line: string[]): string {
    return line.join("").replace(/\s+$/, "");
  }

  private reset(): void {
    this.grid = Array.from({ length: this.rows }, () => this.blankRow());
    this.history = [];
    this.row = 0;
    this.col = 0;
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) {
      this.row += 1;
      return;
    }
    const removed = this.grid.shift() ?? this.blankRow();
    const line = this.trimLine(removed);
    if (line || this.history.length) this.history.push(line);
    if (this.history.length > this.maxScrollback) {
      this.history.splice(0, this.history.length - this.maxScrollback);
    }
    this.grid.push(this.blankRow());
  }

  private reverseIndex(): void {
    if (this.row > 0) {
      this.row -= 1;
      return;
    }
    this.grid.pop();
    this.grid.unshift(this.blankRow());
  }

  private clampCursor(): void {
    this.row = Math.max(0, Math.min(this.rows - 1, this.row));
    this.col = Math.max(0, Math.min(this.cols - 1, this.col));
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.grid = Array.from({ length: this.rows }, () => this.blankRow());
      if (mode === 3) this.history = [];
      return;
    }
    if (mode === 1) {
      for (let row = 0; row <= this.row; row += 1) {
        const limit = row === this.row ? this.col + 1 : this.cols;
        for (let col = 0; col < limit; col += 1) this.grid[row]![col] = " ";
      }
      return;
    }
    for (let row = this.row; row < this.rows; row += 1) {
      const start = row === this.row ? this.col : 0;
      for (let col = start; col < this.cols; col += 1) this.grid[row]![col] = " ";
    }
  }

  private eraseLine(mode: number): void {
    if (mode === 1 || mode === 2) {
      const end = mode === 2 ? this.cols : this.col + 1;
      for (let col = 0; col < end; col += 1) this.grid[this.row]![col] = " ";
    }
    if (mode === 0 || mode === 2) {
      const start = mode === 2 ? 0 : this.col;
      for (let col = start; col < this.cols; col += 1) this.grid[this.row]![col] = " ";
    }
  }

  private consumeEscape(input: string, start: number): number | null {
    if (start + 1 >= input.length) return null;
    const kind = input[start + 1]!;

    if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
      let index = start + 2;
      while (index < input.length) {
        if (input[index] === "\x07") return index + 1;
        if (input[index] === "\x1b" && input[index + 1] === "\\") return index + 2;
        index += 1;
      }
      return null;
    }

    if (kind === "[") {
      let end = start + 2;
      while (end < input.length) {
        const code = input.charCodeAt(end);
        if (code >= 0x40 && code <= 0x7e) break;
        end += 1;
      }
      if (end >= input.length) return null;
      const params = input.slice(start + 2, end);
      this.applyCsi(input[end]!, params);
      return end + 1;
    }

    // Character-set selection such as ESC ( B and ESC ) 0 carries one extra
    // byte. Consume the designation so it never leaks into the chat transcript.
    if ("()*+-./".includes(kind)) {
      return start + 2 < input.length ? start + 3 : null;
    }

    if (kind === "7") {
      this.savedRow = this.row;
      this.savedCol = this.col;
    } else if (kind === "8") {
      this.row = this.savedRow;
      this.col = this.savedCol;
      this.clampCursor();
    } else if (kind === "D") {
      this.lineFeed();
    } else if (kind === "M") {
      this.reverseIndex();
    } else if (kind === "c") {
      this.reset();
    }
    return start + 2;
  }

  private applyCsi(final: string, rawParams: string): void {
    const privateSequence = /[?><=]/.test(rawParams);
    const values = rawParams
      .replace(/[?><=]/g, "")
      .split(";")
      .map((value) => (value === "" ? undefined : Number.parseInt(value, 10)));
    const first = values[0];
    const amount = first || 1;

    if (privateSequence) return;
    if (final === "A") this.row -= amount;
    else if (final === "B") this.row += amount;
    else if (final === "C") this.col += amount;
    else if (final === "D") this.col -= amount;
    else if (final === "E") {
      this.row += amount;
      this.col = 0;
    } else if (final === "F") {
      this.row -= amount;
      this.col = 0;
    } else if (final === "G" || final === "`") this.col = amount - 1;
    else if (final === "d") this.row = amount - 1;
    else if (final === "H" || final === "f") {
      this.row = (values[0] || 1) - 1;
      this.col = (values[1] || 1) - 1;
    } else if (final === "J") this.eraseDisplay(first || 0);
    else if (final === "K") this.eraseLine(first || 0);
    else if (final === "X") {
      for (let col = this.col; col < Math.min(this.cols, this.col + amount); col += 1) {
        this.grid[this.row]![col] = " ";
      }
    } else if (final === "P") {
      const count = Math.min(amount, this.cols - this.col);
      this.grid[this.row]!.splice(this.col, count);
      this.grid[this.row]!.push(...Array(count).fill(" "));
    } else if (final === "@") {
      const count = Math.min(amount, this.cols - this.col);
      this.grid[this.row]!.splice(this.col, 0, ...Array(count).fill(" "));
      this.grid[this.row]!.length = this.cols;
    } else if (final === "L") {
      const count = Math.min(amount, this.rows - this.row);
      this.grid.splice(this.row, 0, ...Array.from({ length: count }, () => this.blankRow()));
      this.grid.length = this.rows;
    } else if (final === "M") {
      const count = Math.min(amount, this.rows - this.row);
      this.grid.splice(this.row, count);
      this.grid.push(...Array.from({ length: count }, () => this.blankRow()));
    } else if (final === "S") {
      for (let count = 0; count < amount; count += 1) {
        this.row = this.rows - 1;
        this.lineFeed();
      }
    } else if (final === "T") {
      for (let count = 0; count < amount; count += 1) this.reverseIndex();
    } else if (final === "s") {
      this.savedRow = this.row;
      this.savedCol = this.col;
    } else if (final === "u") {
      this.row = this.savedRow;
      this.col = this.savedCol;
    }
    this.clampCursor();
  }
}
