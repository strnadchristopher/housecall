import { test } from "@playwright/test";
import { send, setup, row } from "./helpers";

test("dbg", async ({ page }) => {
  await setup(page, "owner");
  await send(page, "Hello dbg");
  const target = row(page, "Hello dbg");
  await target.hover();
  console.log("ROW", (await target.evaluate(el => el.outerHTML)).slice(0, 1800));
});
