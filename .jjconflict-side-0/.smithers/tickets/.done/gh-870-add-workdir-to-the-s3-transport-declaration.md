# Add workdir to the S3 transport declaration

GitHub: https://github.com/smithersai/smithers/issues/870

Update packages/aws/src/index.d.ts so createAwsSandboxS3Transport accepts workdir?: string, and add a type-level test for direct TypeScript callers.


> Closed by ticket-fleet: landed on main in f37cb006ecfa915a564e316dab950d047f2cb698.
