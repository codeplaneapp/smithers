import { createAwsEcsSandboxRunner } from "../index.js";

void createAwsEcsSandboxRunner({
  cluster: "cluster",
  taskDefinition: "task-definition",
  subnets: ["subnet"],
  containerName: "container",
  awslogsStreamPrefix: "logs",
});
