'use latest'

import express from 'express'
import { fromExpress } from 'webtask-tools'
import bodyParser from 'body-parser'
import request from 'request'
import { MongoClient } from 'mongodb'

const app = express()

app.use(bodyParser.json())

app.get('/', (req, res) => {
  const HTML = renderView({
    title: 'Jamstock alerts'
  });

  res.set('Content-Type', 'text/html')
  res.status(200).send(HTML)
});
function renderView(locals) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset='utf-8'>
      <title>${locals.title}</title>

      <script>
        window.fbAsyncInit = function() {
          FB.init({
            appId            : '186408488633476',
            autoLogAppEvents : true,
            xfbml            : true,
            version          : 'v2.12'
          });
        };
      
        (function(d, s, id){
          var js, fjs = d.getElementsByTagName(s)[0];
          if (d.getElementById(id)) {return;}
          js = d.createElement(s); js.id = id;
          js.src = 'https://connect.facebook.net/en_US/sdk.js';
          fjs.parentNode.insertBefore(js, fjs);
        }(document, 'script', 'facebook-jssdk'));
      </script>
    </head>
    <body>
      <div class='fb-messengermessageus' 
        messenger_app_id='186408488633476' 
        page_id='150067269009507'
        color='blue'
        size='xlarge'>
      </div>
    </body>
    </html>
  `
}


app.post('/webhook', (req, res) => {  
 
  let body = req.body;

  // Checks this is an event from a page subscription
  if (body.object === 'page') {

    // Iterates over each entry - there may be multiple if batched
    body.entry.forEach(function(entry) {

      // Gets the message. entry.messaging is an array, but 
      // will only ever contain one message, so we get index 0
      let webhook_event = entry.messaging[0];
      console.log(webhook_event);

      // Get the sender PSID
      let sender_psid = webhook_event.sender.id;
      if (webhook_event.message) {
        handleMessage(sender_psid, webhook_event.message, req.webtaskContext.secrets);        
      } else if (webhook_event.postback) {
        handlePostback(sender_psid, webhook_event.postback, req.webtaskContext.secrets);
      }
    });

    // Returns a '200 OK' response to all requests
    res.status(200).send('EVENT_RECEIVED');
  } else {
    // Returns a '404 Not Found' if event is not from a page subscription
    res.sendStatus(404);
  }

})

app.get('/webhook', (req, res) => {

  // Your verify token. Should be a random string.
  let VERIFY_TOKEN = 'some_token'
    
  // Parse the query params
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];
    
  // Checks if a token and mode is in the query string of the request
  if (mode && token) {
  
    // Checks the mode and token sent is correct
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      
      // Responds with the challenge token from the request
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    
    } else {
      // Responds with '403 Forbidden' if verify tokens do not match
      res.sendStatus(403);      
    }
  }
})

export default fromExpress(app)

// Messenger stuff

function handleMessage(sender_psid, received_message, secrets) {
  // Check if the message contains text
  if (received_message.text) {
    let alert
    let parseError = false
    const parts = received_message.text.split(',')
    try{
      alert = {
        symbol: parts[0].trim().toUpperCase(),
        lower: parseFloat(parts[1].replace(/[^0-9\.]+/g, '')),
        upper: parseFloat(parts[2].replace(/[^0-9\.]+/g, '')),
      }
    } catch(err) {
      parseError = true
    }
    if(parseError) {
      callSendAPI(sender_psid, {
        text: "Format not recognized! Format should be 'Ticker, lower price, upper price' \u000AFor eg. MEEG, 0.25, 1.5"
      }, secrets)
    } else {
      setAlert(sender_psid, secrets, alert)
    }
  }     
}

function handlePostback(sender_psid, received_postback, secrets) {
  let response;
  
  // Get the payload for the postback
  let payload = received_postback.payload;

  // Set the response based on the postback payload
  if (payload === 'start') {
    callSendAPI(sender_psid, { text: 'To setup alerts, type the ticker symbol, a comma, then lower bounds, comma, upper bounds. \u000AFor eg. `KW, 40, 60`' }, secrets)
    return
  }
  // Send the message to acknowledge the postback
  callSendAPI(sender_psid, response, secrets);
}

function callSendAPI(sender_psid, response, secrets) {  
  const { ACCESS_TOKEN } = secrets
  // Construct the message body
  let request_body = {
    recipient: {
      id: sender_psid
    },
    message: response
  }

  request({
    'uri': 'https://graph.facebook.com/v2.6/me/messages',
    'qs': { 'access_token': ACCESS_TOKEN },
    'method': 'POST',
    'json': request_body
  }, (err, res, body) => {
    if (!err) {
      console.log('message sent!')
    } else {
      console.error('Unable to send message:' + err);
    }
  });
}

function setAlert(sender_psid, secrets, alert) {
  const { MONGO_URL, MONGO_DATABASE } = secrets
  MongoClient.connect(MONGO_URL, (err, client) => {

    const db = client.db(MONGO_DATABASE)
    db.collection('users').update({ 
      messengerId: sender_psid,
      alerts: { $elemMatch: { symbol: alert.symbol }}
    },
    {
      $set: {
        'alerts.$.upper': alert.upper,
        'alerts.$.lower': alert.lower,   
      }
    }, 
    {
      multi: false,
      upsert: true
    }, (err, result) => {
      if(err) {
        db.collection('users').update({
          messengerId: sender_psid,
        },
        {
          $push: {
            alerts: {
              'symbol': alert.symbol,
              'upper': alert.upper,
              'lower': alert.lower
            }
          }
        },
        {
          multi: false,
          upsert: true
        }, (err, result) => {
          if(err) {
            callSendAPI(sender_psid, {
              text: `Sorry, we had an error creating that alert! Try again later.`
            })
          }
          client.close()
          sendConfirmation(sender_psid, alert, secrets, false)
        })
      }
      else {
        sendConfirmation(sender_psid, alert, secrets, true)
      }
      client.close()
    })      
  })
}

function sendConfirmation(sender_psid, alert, secrets, isUpdated) {
  callSendAPI(sender_psid, {
    text: `Alert ${isUpdated ? 'updated' : 'created'} for ${alert.symbol}. Lower: $${alert.lower}, Upper: $${alert.upper}`
  }, secrets)
}
