export type Foo = { a: number }
export const hi = (x: Foo): string => `ok ${x.a}`
