export class AsyncMessageQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }

  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close() {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()({ value: undefined, done: true });
    }
  }

  async next() {
    if (this.items.length > 0) {
      return { value: this.items.shift(), done: false };
    }
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => this.next(),
    };
  }
}
