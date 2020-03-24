import * as aws from "aws-sdk";

export async function main({ Records }: any): Promise<any> {
  try {
    console.log(
      "ENVIRONMENT VARIABLES\n" + JSON.stringify(process.env, null, 2)
    );
    console.info("EVENT\n" + JSON.stringify(Records, null, 2));

    // process env, parameters ...
    const { JOB_QUEUE_URL } = process.env;

    // sqs client ...
    const sqs = new aws.SQS({ apiVersion: "2012-11-05" });

    return Promise.all([
      ...Records.map(async ({ s3, object }: any) => {
        const params: aws.SQS.SendMessageRequest = {
          MessageAttributes: {
            Key: {
              DataType: "String",
              StringValue: s3.object.key
            },
            BucketName: {
              DataType: "String",
              StringValue: s3.bucket.name
            }
          },
          MessageBody: JSON.stringify({ ...s3, ...object }),
          QueueUrl: `${JOB_QUEUE_URL}`
        };

        const res = await sqs.sendMessage(params).promise();

        return res.MessageId;
      })
    ]);
  } catch (e) {
    console.error(e);

    return e;
  }
}
