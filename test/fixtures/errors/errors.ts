shared struct S {
  n: number = 0;
  m() {}
}
const s = new S();
s.n = 'not a number';
struct Derived extends S {}
