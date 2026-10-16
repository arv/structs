// Structs: fixed-layout objects. Their fields are all there, and the
// instance sealed, before any initializer runs; then the constructor runs, as
// an initializer. Methods only work on instances of their struct.

struct Point {
  x = 0;
  y = 0;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  length() {
    return Math.hypot(this.x, this.y);
  }
}

struct Point3 extends Point {
  z = 0;
  constructor(x: number, y: number, z: number) {
    super(x, y); // the parent's initializer
    this.z = z;
  }
}

export function main() {
  const p = new Point3(3, 4, 12);
  console.log('fields:', Object.keys(p).join(', '));
  console.log('sealed:', Object.isSealed(p));
  console.log('length of (3, 4):', p.length());
  try {
    (p as any).w = 1;
  } catch (e) {
    console.log('adding a field:', (e as Error).message);
  }
  try {
    Point.prototype.length.call({x: 3, y: 4});
  } catch (e) {
    console.log('a method on a look-alike:', (e as Error).message);
  }
}
