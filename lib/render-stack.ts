import * as cdk from "@aws-cdk/core";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as s3 from "@aws-cdk/aws-s3";
import * as lambda from "@aws-cdk/aws-lambda";
import * as iam from "@aws-cdk/aws-iam";
import * as sqs from "@aws-cdk/aws-sqs";
import * as cloudfront from "@aws-cdk/aws-cloudfront";
import * as autoscaling from "@aws-cdk/aws-autoscaling";
import * as cloudwatch from "@aws-cdk/aws-cloudwatch";
import * as events from "@aws-cdk/aws-events";
import * as targets from "@aws-cdk/aws-events-targets";
import * as sources from "@aws-cdk/aws-lambda-event-sources";
import * as sns from "@aws-cdk/aws-sns";
import * as subs from "@aws-cdk/aws-sns-subscriptions";

interface RenderStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  projectName: string;
  operatorEmail: string;
}

export class RenderStack extends cdk.Stack {
  public readonly assetBucket: s3.Bucket;
  public readonly assetDistribution: cloudfront.IDistribution;
  public readonly assetDistributionOAI: cloudfront.OriginAccessIdentity;
  public readonly jobQueue: sqs.Queue;
  public readonly jobFunction: lambda.Function;
  public readonly jobFunctionRole: iam.Role;
  public readonly jobDlq: sqs.Queue;
  public readonly jobASG: autoscaling.AutoScalingGroup;
  public readonly jobASGSnsTopic: sns.Topic;
  public readonly jobASGTargetTrackingPolicy: autoscaling.TargetTrackingScalingPolicy;
  public readonly jobASGScaleFunction: lambda.Function;
  public readonly jobASGScaleFunctionRole: iam.Role;
  public readonly jobASGSchedule: events.Rule;

  constructor(scope: cdk.Construct, id: string, props: RenderStackProps) {
    super(scope, id);

    // Asset Bucket ...
    this.assetBucket = new s3.Bucket(this, "assetBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      bucketName: `${props.projectName}-asset`,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY // not recommended for production
    });

    this.assetDistributionOAI = new cloudfront.OriginAccessIdentity(
      this,
      "assetDistributionOAI",
      {}
    );

    this.assetBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [`${this.assetBucket.bucketArn}/*`],
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.CanonicalUserPrincipal(
            this.assetDistributionOAI.cloudFrontOriginAccessIdentityS3CanonicalUserId
          )
        ]
      })
    );

    this.assetDistribution = new cloudfront.CloudFrontWebDistribution(
      this,
      "assetDistribution",
      {
        originConfigs: [
          {
            s3OriginSource: {
              s3BucketSource: this.assetBucket,
              originAccessIdentity: this.assetDistributionOAI
            },
            behaviors: [
              {
                isDefaultBehavior: true,
                forwardedValues: { queryString: true },
                allowedMethods: cloudfront.CloudFrontAllowedMethods.ALL
              }
            ]
          }
        ]
      }
    );

    // Sqs queue for render jobs ...
    this.jobQueue = new sqs.Queue(this, "jobQueue", {
      queueName: `${props.projectName}-job-queue`,
      visibilityTimeout: cdk.Duration.seconds(300)
    });
    this.jobDlq = new sqs.Queue(this, "dldQueue", {
      queueName: `${props.projectName}-dlq`
    });

    // Sns topic ...
    this.jobASGSnsTopic = new sns.Topic(this, "jobAsgTopic", {
      topicName: `${props.projectName}-job-asg`
    });
    this.jobASGSnsTopic.addSubscription(
      new subs.EmailSubscription(props.operatorEmail)
    );

    // S3 events ...
    this.jobFunctionRole = new iam.Role(this, "jobFunctionRole", {
      roleName: `${props.projectName}-JobFunctionRole`,
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "jobFunctionRoleARN",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        )
      ],
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com", {})
    });

    this.jobFunctionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [this.jobQueue.queueArn],
        effect: iam.Effect.ALLOW
      })
    );

    this.jobFunctionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:*"],
        resources: [
          `${this.assetBucket.bucketArn}/*`,
          `${this.assetBucket.bucketArn}/`
        ],
        effect: iam.Effect.ALLOW
      })
    );

    this.jobFunction = new lambda.Function(this, "jobFunction", {
      functionName: `${props.projectName}-job`, //overwrites the default generated one
      runtime: lambda.Runtime.NODEJS_12_X,
      code: lambda.Code.asset("handlers"),
      role: this.jobFunctionRole,
      handler: "job.main",
      environment: {
        JOB_QUEUE_URL: `${this.jobQueue.queueUrl}`
      }
    });
    this.jobFunction.addEventSource(
      new sources.S3EventSource(this.assetBucket, {
        events: [s3.EventType.OBJECT_CREATED],
        filters: [{ prefix: "upload/" }]
      })
    );

    // ASG Scale Function ...
    this.jobASG = new autoscaling.AutoScalingGroup(this, "jobASG", {
      vpc: props.vpc,
      minCapacity: 1,
      maxCapacity: 10,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.P2,
        ec2.InstanceSize.XLARGE
      ),
      notificationsTopic: this.jobASGSnsTopic,
      machineImage: new ec2.AmazonLinuxImage()
    });

    this.jobASG.scaleToTrackMetric("jobASGTargetTracking", {
      metric: new cloudwatch.Metric({
        metricName: `${props.projectName}-queue-per-worker`,
        namespace: `Custom`,
        dimensions: {
          [`${props.projectName}-job-target`]: "100"
        },
        statistic: "Average",
        unit: cloudwatch.Unit.NONE
      }),
      targetValue: 100
    });

    const lc = this.jobASG.node.findChild(
      "LaunchConfig"
    ) as autoscaling.CfnLaunchConfiguration;
    lc.addOverride("Metadata", {
      Comment: "Install a simple application",
      "AWS::CloudFormation::Init": {
        config: {
          packages: {
            yum: {
              httpd: [],
              freetype: [],
              "freetype-devel": [],
              "libpng-devel": [],
              "mesa-libGLU-devel": [],
              "libX11-devel": [],
              "mesa-libGL-devel": [],
              "perl-Time-HiRes": [],
              libXi: [],
              libXrender: []
            }
          },
          commands: {
            test: {
              command:
                "curl -L https://ftp.halifax.rwth-aachen.de/blender/release/Blender2.82/blender-2.82a-linux64.tar.xz -o blender-2.82a-linux64.tar.xz && tar xf blender-2.82a-linux64.tar.xz",
              env: {},
              cwd: "~"
            }
          },
          files: {
            "/etc/cfn/cfn-hup.conf": {
              content: `[main]
stack=${this.stackId}
region=${this.region}`,
              mode: "000400",
              owner: "root",
              group: "root"
            },
            "/etc/cfn/hooks.d/cfn-auto-reloader.conf": {
              content: `[cfn-auto-reloader-hook]
triggers=post.update
path=Resources.LaunchConfig.Metadata.AWS::CloudFormation::Init
action=/opt/aws/bin/cfn-init -v stack ${this.stackId} --resource LaunchConfig --region ${this.region}
runas=root
`
            },
            "/home/ec2-user/config.py": {
              content: `import bpy

bpy.context.scene.cycles.device = 'GPU'

for scene in bpy.data.scenes:
    print(scene.name)
    scene.cycles.device = 'GPU'
    scene.render.resolution_percentage = 200
    scene.cycles.samples = 128
bpy.context.preferences.addons['cycles'].preferences.compute_device_type = 'CUDA'
for devices in bpy.context.preferences.addons['cycles'].preferences.get_devices():
    for d in devices:
        d.use = True

for scene in bpy.data.scenes:
    scene.render.filepath = "/tmp/{}.png" . format(scene.name)
    bpy.ops.render.render(scene=scene.name, write_still=True)
`,
              mode: "0744",
              owner: "root",
              group: "root"
            },
            "/home/ec2-user/render.sh": {
              content: `#!/bin/bash
BLEND="/tmp/demo.blend"

/home/ec2-user/blender-2.82a-linux64/blender --enable-autoexec -noaudio --background "$BLEND" --P "config.py"
`,
              mode: "0744",
              owner: "root",
              group: "root"
            }
          },
          services: {
            sysvinit: {
              httpd: { enabled: "true", ensureRunning: "true" },
              "cfn-hup": {
                enabled: "true",
                ensureRunning: "true",
                files: [
                  "/etc/cfn/cfn-hup.conf",
                  "/etc/cfn/hooks.d/cfn-auto-reloader.conf"
                ]
              }
            }
          }
        }
      }
    });

    this.jobASGScaleFunctionRole = new iam.Role(this, "jobASGFunctionRole", {
      roleName: `${props.projectName}-jobASGFunctionRole`,
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "jobASGFunctionRoleARN",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        )
      ],
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com", {})
    });

    this.jobASGScaleFunctionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sqs:*"],
        resources: [this.jobQueue.queueArn],
        effect: iam.Effect.ALLOW
      })
    );

    this.jobASGScaleFunctionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData", "cloudwatch:GetMetricData"],
        resources: ["*"],
        effect: iam.Effect.ALLOW
      })
    );

    this.jobASGScaleFunctionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["autoscaling:Describe*"],
        resources: ["*"],
        effect: iam.Effect.ALLOW
      })
    );

    this.jobASGScaleFunction = new lambda.Function(this, "jobASGFunction", {
      functionName: `${props.projectName}-asg`, //overwrites the default generated one
      runtime: lambda.Runtime.NODEJS_12_X,
      code: lambda.Code.asset("handlers"),
      role: this.jobASGScaleFunctionRole,
      handler: "asg.main",
      environment: {
        JOB_QUEUE_URL: `${this.jobQueue.queueUrl}`,
        ASG_NAME: `${this.jobASG.autoScalingGroupName}`,
        METRIC_NAMESPACE: "Custom",
        METRIC_NAME: `${props.projectName}-job-target`
      }
    });

    this.jobASGSchedule = new events.Rule(this, "jobASGSchedule", {
      description: "Rule to trigger the scheduled ASG function",
      schedule: events.Schedule.cron({
        minute: "0/1",
        hour: "*",
        day: "*",
        year: "*"
      }),
      targets: [new targets.LambdaFunction(this.jobASGScaleFunction, {})]
    });
  }
}
