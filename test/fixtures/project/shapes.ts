// Shared structs in TypeScript (test/compile.test.ts).

import '@arv/structs';

// its fields are numbers, but not declared so: untyped (src/runtime/shared.ts)
export shared struct Vec {
  x = 0;
  y = 0;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

export shared struct Body extends Vec {
  mass: number = 1;
  name: string = 'body';
  next: Body | null = null;
  // a struct with no constructor does not call its parent's (§1.1.6)
  constructor(x: number, y: number) {
    super(x, y);
  }
}

export struct Local {
  count = 0;
  bump(): number {
    return ++this.count;
  }
}
