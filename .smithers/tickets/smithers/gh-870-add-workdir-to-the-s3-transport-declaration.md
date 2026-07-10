# Add workdir to the S3 transport declaration

GitHub: https://github.com/smithersai/smithers/issues/870

Update packages/aws/src/index.d.ts so createAwsSandboxS3Transport accepts workdir?: string, and add a type-level test for direct TypeScript callers.
