import { expect, test } from "bun:test"
import { greeting } from "greeting"

test("web resolves its workspace dependency", () => {
  expect(greeting("workspace")).toBe("hello, workspace")
})
