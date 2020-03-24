#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "@aws-cdk/core";
import { CoreStack } from "../lib/core-stack";
import { RenderStack } from "../lib/render-stack";

const app = new cdk.App();

const projectName = app.node.tryGetContext("projectName");

const coreStack = new CoreStack(app, "CoreStack", {
  stackName: `CoreStack-${projectName}`
});
const renderStack = new RenderStack(app, "RenderStack", {
  stackName: `RenderStack-${projectName}`,
  projectName: projectName,
  vpc: coreStack.vpc
});
renderStack.addDependency(coreStack);
