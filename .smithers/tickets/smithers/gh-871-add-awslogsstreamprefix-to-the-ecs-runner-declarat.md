# Add awslogsStreamPrefix to the ECS runner declaration

GitHub: https://github.com/smithersai/smithers/issues/871

Update packages/aws/src/index.d.ts so createAwsEcsSandboxRunner accepts awslogsStreamPrefix?: string, and add a type-level test for direct TypeScript callers.
