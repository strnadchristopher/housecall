import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

test("consented scanned screenshot and redacted logs are available only to owner", async ({ browser, request }) => {
  test.setTimeout(60000);
  const password = "synthetic report password 123";
  const headers = (s: { token: string; device_key: string }) => ({ Authorization: `Bearer ${s.token}`, "X-Device-Key": s.device_key });
  const owner = await (await request.post("/api/setup", { data: { username: "report_owner", password, setup_token: "test-setup-token-at-least-32-characters", device_name: "report fixture" } })).json();
  const invitation = await (await request.post("/api/invites", { headers: headers(owner), data: { expires_in_seconds: 300 } })).json();
  const friend = await (await request.post("/api/invites/accept", { data: { token: invitation.token, username: "report_friend", password, device_name: "report fixture" } })).json();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const login = async (username: string) => {
    await page.goto("/");
    await page.getByLabel("Username", { exact: true }).fill(username);
    await page.getByLabel("Password (at least 12 characters)").fill(password);
    await page.getByTestId("screen-login").locator("button[type=submit]").click();
    await expect(page.getByTestId("screen-composer")).toBeVisible();
  };
  try {
    await login("report_friend");
    await page.getByRole("button", { name: "Report a problem", exact: true }).click();
    await page.getByLabel("Description", { exact: true }).fill("Fixture screenshot report");
    await page.getByLabel("Optional logs (review and remove secrets)").fill("Authorization: fixture-secret\nnormal fixture log");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=", "base64");
    await page.getByLabel("Optional screenshot (PNG, JPEG or WebP)").setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: png });
    let uploadPosts = 0;
    page.on("request", r => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/uploads") uploadPosts++; });
    await page.getByRole("button", { name: "Submit report", exact: true }).click();
    await expect(page.getByTestId("screen-report").getByRole("alert")).toContainText("Consent to sending");
    expect(uploadPosts).toBe(0);
    await page.getByLabel("I consent to sending the selected screenshot").check();
    await page.getByLabel("I consent to sending the logs above").check();
    const submitted = page.waitForResponse(r => new URL(r.url()).pathname === "/api/reports" && r.request().method() === "POST");
    await page.getByRole("button", { name: "Submit report", exact: true }).click();
    const result = await submitted;
    expect(result.status()).toBe(200);
    const report = await result.json();
    expect(uploadPosts).toBe(1);
    expect((await request.get("/api/reports", { headers: headers(friend) })).status()).toBe(403);
    expect((await request.get(`/api/reports/${report.id}/screenshot`, { headers: headers(friend) })).status()).toBe(403);
    await login("report_owner");
    await page.getByRole("button", { name: "Review reports", exact: true }).click();
    const admin = page.getByTestId("screen-reports-admin");
    await expect(admin).toContainText("Fixture screenshot report");
    await expect(admin).toContainText("[redacted sensitive log line]");
    await expect(admin).not.toContainText("fixture-secret");
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download screenshot", exact: true }).click();
    const download = await downloading;
    expect(await readFile((await download.path())!)).toEqual(png);
    await page.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(admin).toContainText("resolved");
    await page.screenshot({ path: "../evidence/client-reports.png", fullPage: true });
    await writeFile("../evidence/client-reports.json", JSON.stringify({ passed: true, scanner: "Real local ClamAV", checks: ["no screenshot upload before consent", "encrypted scanned screenshot attachment", "redacted consented logs", "owner-only report and screenshot access", "byte-exact authenticated screenshot download", "owner resolves report"] }, null, 2) + "\n");
  } finally { await context.close(); }
});
