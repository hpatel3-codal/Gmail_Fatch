import { test, expect } from "@playwright/test";
import { waitAndExtractUrlByRecipient } from "../utils/gmailHelpers";
import emailData from "../fixtures/emailFilters.json";

test.describe.configure({ mode: "serial" });

test("extract verify URL by recipient + subject", async ({ page }) => {
  const url = await waitAndExtractUrlByRecipient(
    emailData.recipientEmail,
    emailData.subjectKeyword,
    emailData.urlKeyword,
    emailData.timeoutSeconds,
    emailData.pollIntervalMs,
    emailData.options
  );

  console.log("✅ Found URL:", url);
  await page.goto(url);
  await expect(page).toHaveURL(/verify/i);
});