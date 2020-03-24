#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "@aws-cdk/core";
import { CoreStack } from "../lib/core-stack";
import { RenderStack } from "../lib/render-stack";

const app = new cdk.App();

const projectName = app.node.tryGetContext("projectName");
const operatorEmail = app.node.tryGetContext("operatorEmail");

const coreStack = new CoreStack(app, "CoreStack", {
  stackName: `CoreStack-${projectName}`
});
const renderStack = new RenderStack(app, "RenderStack", {
  stackName: `RenderStack-${projectName}`,
  operatorEmail,
  projectName,
  vpc: coreStack.vpc
});
renderStack.addDependency(coreStack);
