export class RollingBuffer {
  private buf: number[] = [];
  constructor(private max: number) { }
  push(v: number) {
    this.buf.push(v);
    if (this.buf.length > this.max) this.buf.shift();
  }
  toArray() {
    return this.buf.slice();
  }
  last(n = 1) {
    return this.buf.length ? this.buf[this.buf.length - n] : null;
  }
  length() {
    return this.buf.length;
  }
}
