# Add Cloudflare declaration freshness coverage

GitHub: https://github.com/smithersai/smithers/issues/846

Extend the declaration freshness CI gate to include packages/cloudflare, ensuring its committed src/index.d.ts is regenerated, compared for drift, and restored safely during the check.
