'use latest'
import { parallel } from 'async'
import request from 'request'
import cheerio from 'cheerio'
import { MongoClient } from 'mongodb'

export default (ctx, done) => {

  request('https://www.jamstockex.com/ticker-data', (err, response, body) => {
    if(err) return done(err)
    if(response && response.statusCode != 200) return done('ticker did not return http 200')

    const stockUpdates = parseTicker(body)

    MongoClient.connect(ctx.data.MONGO_URL, (err, client) => {
      if(err) return done(err)
   
      const jobs = stockUpdates.map((stock) => {
        return (cb) => {
          beginNotificationJob(stock, client.db(ctx.data.MONGO_DATABASE), ctx, (err) => {
            if(err) return cb(err)

            cb(null)
          })
        }
      })

      parallel(jobs, (err)  => {
        client.close()
        if(err) return done(err)

        done(null, 'Success.')
      })
    })
  })
}

function parseTicker(content) {
  const stocks = []

  const tickerHtml = cheerio.load(content)  
  tickerHtml('li a').each((index, element) => {
    const els = cheerio(element).html().split('<br>')
    const trimmedSymbolSection = els[0].trim().toUpperCase()
    const symbolHasSpaces = trimmedSymbolSection.indexOf(' ') !== -1
    const symbol = symbolHasSpaces ? trimmedSymbolSection.substr(0, trimmedSymbolSection.indexOf(' ')) : trimmedSymbolSection
    const priceStr = els[2].substr(0, els[2].indexOf('<img'))
    const price = parseFloat(priceStr.replace(/[^0-9\.]+/g, ''))

    stocks.push({symbol, price})
  })

  return stocks
}

function beginNotificationJob(stock, db, ctx, cb) {
  db.collection('users').find({ 
    $and: [
        { 'alerts.symbol': stock.symbol },
        { $or: [ { 'alerts.lower': { $gt: stock.price }}, { 'alerts.upper': { $lt: stock.price }} ] }
    ] 
  }).toArray((err, users) => {
    if(err) return cb(err)

    if(users.length < 1) return cb(null)

    users.forEach((user) => {
      notifyUser(user, stock, db, ctx, cb)
    })
  })
  
}

function notifyUser(user, stock, db, ctx, cb) {
  const response = {
    text: `ALERT! ${stock.symbol} has reached the price of $${stock.price}!\u000A Create a new alert to be notified of changes.`
  }
  callSendAPI(user.messengerId, response, db, ctx, (err) => {
    if(err) return cb(err)

    disableAlert(user.messengerId, stock, db, cb)
  })
}

function callSendAPI(sender_psid, response, db, ctx, cb) {
  // Construct the message body
  let request_body = {
    recipient: {
      id: sender_psid
    },
    message: response
  }

  request({
    'uri': 'https://graph.facebook.com/v2.6/me/messages',
    'qs': { 'access_token': ctx.data.ACCESS_TOKEN },
    'method': 'POST',
    'json': request_body
  }, (err, res, body) => {
    if (!err) {
      console.log('message sent!')
      cb(null)
    } else {
      cb(err)
      console.error('Unable to send message:' + err);
    }
  });
}

function disableAlert(messengerId, stock, db, cb) {
  db.collection('users').update({ 
    messengerId: messengerId
  },
  {
    $pull: {
      alerts: { symbol: stock.symbol }
    }
  }, 
  {
    multi: false,
    upsert: false
  }, (err, result) => {
    if(err) return cb(err)

    cb(null)
  })
}