// What the compiler catches before anything runs, and what the runtime
// throws. The errors are listed under the JavaScript, and marked here.

shared struct Account {
  balance: number = 0;
  // a shared struct has no methods (§2.2.3): its instances have no prototype
  deposit(n: number) {
    this.balance += n;
  }
}

struct Point {
  x = 0;
}

export function main() {
  const p = new Point();
  // TypeScript sees structs as classes: a field's type is checked
  p.x = 'one';
}
