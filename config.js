require('dotenv').config();

module.exports = {
  BOT_NAME: process.env.BOT_NAME || 'Chaplin MD v2.5',
  OWNER_NAME: 'Malvin C',
  OWNER_NUMBER: process.env.OWNER_NUMBER || '263780026088', // used for owner-only commands, digits only, no +
  // If set, the bot automatically requests a pairing code for this number on
  // every boot (until it's actually paired), and prints it in the console —
  // no need to visit the website. Digits only, no +. Set to '' to disable.
  PAIR_NUMBER: process.env.PAIR_NUMBER || '263780026088',
  POWERED_BY: "Handsome Tech ZW",
  PREFIX: process.env.PREFIX || '.',
  SESSION_ID: process.env.SESSION_ID || '', // paste the code the pairing website gives you
  PORT: process.env.PORT || 3000,
  // Any https image works here. Swap it for your own to fully customize the bot's look.
  MENU_IMAGE: process.env.MENU_IMAGE || 'https://files.catbox.moe/uj95z3.jpg',
  SELF_URL: process.env.SELF_URL || '', // your Render URL, e.g. https://chaplin-md.onrender.com — used for keep-alive
  MAX_AUDIO_MB: 15
};
