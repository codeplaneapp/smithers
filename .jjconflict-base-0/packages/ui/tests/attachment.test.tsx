/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Attachment } from "../src/index";
import { installDarkThemeStyles, removeDarkThemeStyles } from "./theme-test-utils";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  removeDarkThemeStyles();
});

describe("Attachment", () => {
  test("renders file metadata and extension fallback", () => {
    const sized = renderToStaticMarkup(
      <Attachment name="report.pdf" sizeBytes={2048} mediaType="application/pdf" />,
    );
    expect(sized).toContain("PDF");
    expect(sized).toContain("2.0 KB · application/pdf");
    const extensionless = renderToStaticMarkup(<Attachment name="README" />);
    expect(extensionless).toContain("FILE");
  });

  test("numeric progress exposes aria-valuenow while indeterminate progress omits it", () => {
    const numeric = renderToStaticMarkup(
      <Attachment name="photo.png" state="uploading" progress={42} />,
    );
    expect(numeric).toContain('role="progressbar"');
    expect(numeric).toContain('aria-valuenow="42"');
    expect(numeric).toContain('aria-label="Uploading photo.png"');

    const indeterminate = renderToStaticMarkup(
      <Attachment name="photo.png" state="processing" progress={null} />,
    );
    expect(indeterminate).toContain('role="progressbar"');
    expect(indeterminate).not.toContain("aria-valuenow");
    expect(indeterminate).toContain("sui-attachment-progress-indeterminate");
  });

  test("defined progress always renders while undefined progress never does", () => {
    const ready = renderToStaticMarkup(<Attachment name="ready.txt" state="ready" progress={100} />);
    expect(ready).toContain('data-slot="attachment-progress"');
    expect(ready).toContain('aria-valuenow="100"');

    const failed = renderToStaticMarkup(<Attachment name="failed.txt" state="error" progress={null} />);
    expect(failed).toContain('data-slot="attachment-progress"');
    expect(failed).toContain("sui-attachment-progress-indeterminate");

    const uploading = renderToStaticMarkup(<Attachment name="uploading.txt" state="uploading" />);
    const processing = renderToStaticMarkup(<Attachment name="processing.txt" state="processing" />);
    expect(uploading).not.toContain('data-slot="attachment-progress"');
    expect(processing).not.toContain('data-slot="attachment-progress"');
  });

  test("renders frozen upload, processing, and error labels", () => {
    expect(renderToStaticMarkup(<Attachment name="a" state="uploading" />)).toContain("Uploading…");
    expect(renderToStaticMarkup(<Attachment name="a" state="processing" />)).toContain("Processing…");
    expect(renderToStaticMarkup(<Attachment name="a" state="error" />)).toContain("Failed");
  });

  test("renders thumbnail and accessible remove action", () => {
    const html = renderToStaticMarkup(
      <Attachment name="photo.png" thumbnailUrl="/photo.png" onRemove={() => {}} />,
    );
    expect(html).toContain('<img src="/photo.png" alt=""');
    expect(html).toContain('aria-label="Remove photo.png"');
  });

  test("renders under the dark theme", () => {
    installDarkThemeStyles();
    document.documentElement.dataset.theme = "dark";
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<Attachment name="dark.txt" />);
    document.body.appendChild(host);
    const attachment = host.querySelector<HTMLElement>('[data-slot="attachment"]')!;
    expect(getComputedStyle(attachment).backgroundColor).toBe("#141417");
    host.remove();
  });
});
