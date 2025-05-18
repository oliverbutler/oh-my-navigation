// @ts-nocheck
export function testFunction(a: number, b: number): number {
  return a + b;
}

function privateFunction() {
  return "I'm private";
}

const arrowFunction = () => {
  return "I'm an arrow function";
};

const asyncArrowFunction = async () => {
  return Promise.resolve("I'm async");
};

export const exportedArrow = (x: number) => x * x;
