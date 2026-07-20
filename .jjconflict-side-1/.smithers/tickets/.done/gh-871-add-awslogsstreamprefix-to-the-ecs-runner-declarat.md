# Add awslogsStreamPrefix to the ECS runner declaration

GitHub: https://github.com/smithersai/smithers/issues/871

Update packages/aws/src/index.d.ts so createAwsEcsSandboxRunner accepts awslogsStreamPrefix?: string, and add a type-level test for direct TypeScript callers.


> Closed by ticket-fleet: landed on main in d41acfcdea6bf9ba599eb5f673569e90c9f9e775.
