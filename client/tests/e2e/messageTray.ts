import { expect, type Page } from "@playwright/test";

/** The channel glyph is painted on phones and has no navigation/action handler. */
export async function tapAwayFromMessageTray(page: Page) {
  const glyph = page.locator(".hc-center .hc-header__glyph");
  await expect(glyph).toBeVisible({ timeout: 15000 });
  const hit = await glyph.evaluate(element => {
    const box = element.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    const target = document.elementFromPoint(x, y);
    return {
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      receivesTap: !!target && element.contains(target),
      interactive: !!target?.closest("button, a, input, textarea, [role=button], [data-message-id]"),
      overlapsTray: [...document.querySelectorAll(".hc-msg.is-open .hc-msg__bar")].some(tray => {
        const rect = tray.getBoundingClientRect(); return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      }),
    };
  }, undefined, { timeout: 15000 });
  expect(hit, "Neutral glyph center must receive a tap outside the tray and any action").toMatchObject({ receivesTap: true, interactive: false, overlapsTray: false });
  await glyph.tap({ timeout: 15000 });
}
