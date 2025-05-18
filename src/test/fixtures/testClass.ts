// @ts-nocheck
export class TestClass {
  constructor(private prop: string) {}

  public testMethod() {
    return this.prop;
  }
}

class PrivateClass {
  static factoryMethod() {
    return new PrivateClass();
  }
}
