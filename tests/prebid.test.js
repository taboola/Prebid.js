const {test, expect} = require('@playwright/test');

test('win events', async ({page}) => {

  // Set up a listener for network requests
  let networkEventFound = false;
  let requestUrl = '';
  let responseStatus = null;

  page.on('request', (request) => {
    if (request.url().includes('recommendations.notify-win-nurl')) {
      networkEventFound = true;
      requestUrl = request.url();
    }
  });

  page.on('response', async (response) => {
    if (response.url().includes('recommendations.notify-win-nurl')) {
      responseStatus = response.status();
    }
  });

  // Navigate to the URL
  await page.goto('http://prebid.audex.svc.kube.taboolasyndication.com:9999/integrationExamples/gpt/hello_world.html');

  // Wait for some time to ensure all network requests are captured
  await page.waitForTimeout(5000); // Wait for 5 seconds or adjust as needed

  // Check if the network event was found and its status
  if (networkEventFound) {
    if (responseStatus !== null) {
      console.log(`Network event with "recommendations.notify-win-nurl" found Status: ${responseStatus}`);
      await expect(responseStatus).toEqual(204);
    } else {
      console.log('Network event with "recommendations.notify-win-nurl" found, but no response status captured.');
    }
  } else {
    console.log('Network event with "recommendations.notify-win-nurl" not found.');
  }

});

