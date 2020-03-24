import * as aws from "aws-sdk";
import { Instance } from "@aws-cdk/aws-ec2";

export async function main(event: any): Promise<any> {
  try {
    console.log(
      "ENVIRONMENT VARIABLES\n" + JSON.stringify(process.env, null, 2)
    );
    console.info("EVENT\n" + JSON.stringify(event, null, 2));

    // process env, parameters ...
    const {
      JOB_QUEUE_URL,
      ASG_NAME,
      METRIC_NAMESPACE,
      METRIC_NAME
    } = process.env;

    // sqs client ...
    const sqs = new aws.SQS({ apiVersion: "2012-11-05" });
    const asg = new aws.AutoScaling({ apiVersion: "2012-11-05" });
    const cloudwatch = new aws.CloudWatch({ apiVersion: "2012-11-05" });

    // get the appox. number of messages ...
    const attrs = await sqs
      .getQueueAttributes({
        QueueUrl: `${JOB_QUEUE_URL}`,
        AttributeNames: ["All"]
      })
      .promise();

    const numMsg = parseInt(
      attrs.Attributes?.ApproximateNumberOfMessages || "100"
    );

    // get autoscaling group instances
    const asgs = await asg
      .describeAutoScalingGroups({
        AutoScalingGroupNames: [`${ASG_NAME}`]
      })
      .promise();

    const group = asgs.AutoScalingGroups.find(
      a => a.AutoScalingGroupName === `${ASG_NAME}`
    );
    const instances = group?.Instances?.length || 1;

    const res = await cloudwatch
      .putMetricData({
        Namespace: `${METRIC_NAMESPACE}`,
        MetricData: [
          { MetricName: `${METRIC_NAME}`, Value: numMsg / instances }
        ]
      })
      .promise();

    return res.$response.requestId;
  } catch (e) {
    console.error(e);
    return e;
  }
}
