import { expect as expectCDK, matchTemplate, MatchStyle } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import Core = require('../lib/core-stack');

test('Empty Stack', () => {
    const app = new cdk.App();
    // WHEN
    const stack = new Core.CoreStack(app, 'MyTestStack');
    // THEN
    expectCDK(stack).to(matchTemplate({
      "Resources": {}
    }, MatchStyle.EXACT))
});