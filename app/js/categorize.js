/* Merchant normalisation + rule-based categorisation (tuned for Indian merchants). */
(function () {
  'use strict';

  // Category metadata: nature = essential | discretionary | cost | transfer | income
  const CATEGORIES = {
    'Food delivery':        { nature: 'discretionary' },
    'Dining out':           { nature: 'discretionary' },
    'Groceries':            { nature: 'essential' },
    'Shopping':             { nature: 'discretionary' },
    'Travel':               { nature: 'discretionary' },
    'Local transport':      { nature: 'essential' },
    'Fuel':                 { nature: 'essential' },
    'Bills & utilities':    { nature: 'essential' },
    'Recharge':             { nature: 'essential' },
    'Entertainment & OTT':  { nature: 'discretionary' },
    'Software & digital':   { nature: 'discretionary' },
    'Health & fitness':     { nature: 'essential' },
    'Hospital':             { nature: 'essential' },
    'Education':            { nature: 'essential' },
    'Insurance':            { nature: 'essential' },
    'Rent & housing':       { nature: 'essential' },
    'Personal care':        { nature: 'discretionary' },
    'Wallet & UPI transfers': { nature: 'discretionary' },
    'UPI merchants':        { nature: 'discretionary' },
    'Cash advance':         { nature: 'cost' },
    'EMI':                  { nature: 'essential' },
    'Interest & finance charges': { nature: 'cost' },
    'Late payment fees':    { nature: 'cost' },
    'Card fees':            { nature: 'cost' },
    'Taxes (GST)':          { nature: 'cost' },
    'Forex markup':         { nature: 'cost' },
    'Fuel surcharge':       { nature: 'cost' },
    'Other':                { nature: 'discretionary' },
    // credits
    'Card payment':         { nature: 'transfer' },
    'Cashback & rewards':   { nature: 'income' },
    'Refund / reversal':    { nature: 'income' },
  };

  const DEBIT_RULES = [
    ['Interest & finance charges', /\b(FINANCE CHARGES?|INTEREST|FIN CHGS?|FINANCE CHGS?)\b/],
    ['Late payment fees', /\bLATE (PAYMENT )?(FEE|CHARGE)|LATE PAY/],
    ['Forex markup', /MARKUP|MARK UP|FOREIGN CURRENCY|CROSS CURRENCY|DCC FEE|FX FEE/],
    ['Fuel surcharge', /SURCHARGE/],
    ['Taxes (GST)', /\b(IGST|CGST|SGST|GST|SERVICE TAX)\b/],
    ['Card fees', /\b(ANNUAL|MEMBERSHIP|JOINING|RENEWAL|PROCESSING|OVERLIMIT|OVER LIMIT|CHEQUE RETURN|RETURN|REISSUE|CARD REPLACEMENT|REDEMPTION)\b.*\b(FEE|FEES|CHARGE|CHARGES|CHG)\b|\bFEE\b/],
    ['Cash advance', /CASH WITHDRAWAL|ATM WDL|\bATM\b|CASH ADVANCE/],
    ['EMI', /\bEMI\b|SMARTEMI|LOAN ON CARD|INSTA LOAN/],
    ['Hospital', /HOSPITALS?\b|NURSING HOME|MEDICAL (CENTRE|CENTER|COLLEGE)|MULTI ?SPECIALITY|SUPER ?SPECIALITY|MAX HEALTHCARE|MANIPAL HOSP|FORTIS|NARAYANA (HEALTH|HRUDAYALAYA)|ASTER (CMI|MEDCITY|RV|WHITEFIELD|PRIME)|MEDANTA|\bAIIMS\b|\bKIMS\b|CLOUD ?NINE|MOTHERHOOD|RAINBOW CHILDREN|SPARSH|COLUMBIA ASIA|SAKRA|GLENEAGLES|KOKILABEN|LILAVATI|HINDUJA|JASLOK|BREACH CANDY|RUBY HALL|YASHODA|NETHRALAYA|AGARWAL EYE|VASAN EYE/],
    ['Groceries', /INSTAMART|BLINKIT|GROFERS|ZEPTO|BIGBASKET|BB NOW|DMART|AVENUE SUPERMART|JIOMART|MORE RETAIL|RELIANCE (FRESH|SMART|RETAIL)|SPENCER|NATURE.?S BASKET|SUPERMARKET|HYPERMARKET|GROCER|KIRANA|FRESH TO HOME|LICIOUS|COUNTRY DELIGHT|MILKBASKET|DUNZO|STAR BAZAAR|RATNADEEP|VEGETABLE|FRUITS/],
    ['Food delivery', /SWIGGY(?!.*DINEOUT)|ZOMATO(?!.*(DISTRICT|DINING))|EATSURE|DOMINO|MCDONALD|\bKFC\b|PIZZA ?HUT|BURGER KING|SUBWAY|FAASOS|BEHROUZ|BOX8|FRESHMENU|MAGICPIN/],
    ['Dining out', /DINEOUT|RESTAURANT|RESTRO|CAFE|COFFEE|STARBUCKS|CHAAYOS|CHAI|BREW|\bPUB\b|\bBAR\b|BAKERY|BAKERS|BIRYANI|DHABA|KITCHEN|FOODS?\b|SWEETS|JUICE|ICE ?CREAM|BARBEQUE|HALDIRAM|EAT ?CLUB|THIRD WAVE|BLUE TOKAI/],
    ['Shopping', /AMAZON(?!.*(PRIME|PAY))|AMZN|FLIPKART|MYNTRA|AJIO|NYKAA|MEESHO|TATA ?CLIQ|CROMA|RELIANCE DIGITAL|VIJAY SALES|DECATHLON|IKEA|LIFESTYLE|SHOPPERS STOP|WESTSIDE|\bZARA\b|H ?& ?M|UNIQLO|PANTALOONS|TRENDS|MAX FASHION|MARKS ?& ?SPENCER|PEPPERFRY|URBAN LADDER|LENSKART|FIRSTCRY|BEWAKOOF|SNAPDEAL|APPLE STORE|SAMSUNG|ONEPLUS|XIAOMI|BATA|PUMA|ADIDAS|NIKE|TANISHQ|JEWEL|FOOTWEAR|GARMENT|TEXTILE|ELECTRONICS/],
    ['Travel', /IRCTC|MAKEMYTRIP|MAKE MY TRIP|GOIBIBO|CLEARTRIP|YATRA|IXIGO|EASEMYTRIP|INDIGO|INTERGLOBE|AIR INDIA|AIRINDIA|VISTARA|AKASA|SPICEJET|AIRASIA|REDBUS|ABHIBUS|AIRBNB|\bOYO\b|HOTEL|RESORT|AGODA|BOOKING\.COM|EXPEDIA|TRAVEL|TOURS|AIRLINE|AIRPORT|RAILWAY|KSRTC|TSRTC|MSRTC/],
    ['Local transport', /\bUBER\b|\bOLA\b|OLACABS|ANI TECHNOLOGIES|RAPIDO|ROPPEN|METRO|\bKMRL\b|NAMMA YATRI|BLUSMART|FASTAG|PARKING|TOLL|YULU|BOUNCE/],
    ['Fuel', /PETROL|FUEL|\bHPCL\b|\bBPCL\b|\bIOCL?\b|INDIAN OIL|BHARAT PETROLEUM|HINDUSTAN PETROLEUM|\bSHELL\b|NAYARA|FILLING|SERVICE STATION|AUTOMOBILES|\bHP PAY\b/],
    ['Recharge', /RECHARGE|PREPAID|TOP ?UP|\bDTH\b|TATA ?PLAY|TATA SKY|DISH ?TV|\bD2H\b|SUN DIRECT|AIRTEL DIGITAL TV/],
    ['Bills & utilities', /ELECTRICITY|BESCOM|MSEDCL|TNEB|TNPDCL|KSEB|TATA POWER|ADANI (ELECTRICITY|GAS)|TORRENT POWER|\bWATER\b|\bGAS\b|INDANE|BHARATGAS|HP GAS|AIRTEL|\bJIO\b|RELIANCE JIO|VODAFONE|\bVI\b|IDEA|BSNL|ACT FIBERNET|HATHWAY|BROADBAND|BILLDESK|BILL ?PAY|BBPS|POSTPAID|UTILITY/],
    ['Entertainment & OTT', /NETFLIX|SPOTIFY|HOTSTAR|DISNEY|PRIME ?VIDEO|AMAZON PRIME|YOUTUBE|SONY ?LIV|ZEE5|JIO ?CINEMA|JIOHOTSTAR|BOOKMYSHOW|BOOK MY SHOW|\bPVR\b|INOX|CINEPOLIS|DISTRICT|PAYTM INSIDER|GAANA|WYNK|AUDIBLE|STEAM|PLAYSTATION|XBOX|NINTENDO|GAMING/],
    ['Software & digital', /GOOGLE|APPLE\.COM|ITUNES|APPLE SERVICES|MICROSOFT|MSFT|ADOBE|CANVA|NOTION|GITHUB|OPENAI|CHATGPT|ANTHROPIC|CLAUDE|DROPBOX|ZOOM|LINKEDIN|GODADDY|HOSTINGER|AWS|DIGITALOCEAN|NAMECHEAP|ICLOUD|PERPLEXITY|MEDIUM|SUBSTACK|PATREON/],
    ['Health & fitness', /PHARMA|PHARMACY|CHEMIST|MEDICAL|MEDICALS|APOLLO|MEDPLUS|NETMEDS|PHARMEASY|1MG|CLINIC|DIAGNOSTIC|PATHLAB|LAB\b|(?<!STAR )HEALTH(?!.*INSUR)|DENTAL|CARE\b|CULT\.?FIT|CUREFIT|\bGYM\b|FITNESS|PRACTO|MANIPAL|NARAYANA|ASTER/],
    ['Education', /UDEMY|COURSERA|EDX|SCHOOL|COLLEGE|UNIVERSITY|BYJU|UNACADEMY|VEDANTU|UPGRAD|SIMPLILEARN|BOOKS?\b|KINDLE|ACADEMY|INSTITUTE|TUITION/],
    ['Insurance', /INSURANCE|\bLIC\b|POLICYBAZAAR|HDFC LIFE|ICICI ?PRU|ICICI LOMBARD|BAJAJ ALLIANZ|STAR HEALTH|NIVA BUPA|TATA AIG|ACKO|DIGIT/],
    ['Rent & housing', /\bRENT\b|NOBROKER|HOUSING|MAINTENANCE|SOCIETY|MYGATE|APARTMENT|CRED RENT|REDGIRAFFE|URBAN ?COMPANY|URBANCLAP/],
    ['Personal care', /SALON|SPA\b|PARLOUR|PARLOR|BARBER|GROOMING|NAILS|LAKME|NATURALS|TONI/],
    ['Wallet & UPI transfers', /PAYTM|PHONEPE|AMAZON ?PAY|MOBIKWIK|WALLET|FREECHARGE|ADD MONEY|\bGPAY\b|GOOGLEPAY/],
    ['Shopping', /\bMOBILES?\b|RETAIL|\bMART\b|\bSTORES?\b|\bSHOP\b|ENTERPRISES|TRADERS/],
  ];

  const CREDIT_RULES = [
    ['Card payment', /PAYMENT|PAYMT|PYMT|THANK YOU|BBPS|NEFT|IMPS|RTGS|NETBANKING|NET BANKING|AUTO ?PAY|AUTODEBIT|AUTO DEBIT|\bCRED\b|CREDCLUB|BILLDESK|\bUPI\b.*(PAY|PMT)|CC PAYMENT|TELEBANKING|ONLINE PMT/],
    ['Cashback & rewards', /CASHBACK|CASH BACK|REWARD|REDEMPTION|REDEEM|POINTS|BONUS|OFFER|PROMO/],
  ];

  const BRANDS = [
    ['Swiggy Instamart', /INSTAMART/], ['Swiggy Dineout', /SWIGGY ?DINEOUT|DINEOUT/], ['Swiggy', /SWIGGY|BUNDL TECHNOLOGIES/],
    ['Zomato', /ZOMATO/], ['Blinkit', /BLINKIT|GROFERS/], ['Zepto', /ZEPTO|KIRANAKART/], ['BigBasket', /BIGBASKET|BB NOW|INNOVATIVE RETAIL/],
    ['Amazon Prime', /AMAZON ?PRIME|PRIMEVIDEO/], ['Amazon Pay', /AMAZON ?PAY/], ['Amazon', /AMAZON|AMZN/], ['Flipkart', /FLIPKART/], ['Myntra', /MYNTRA/],
    ['Ajio', /AJIO/], ['Nykaa', /NYKAA/], ['Meesho', /MEESHO/], ['DMart', /DMART|AVENUE SUPERMART/], ['JioMart', /JIOMART/],
    ['Uber', /\bUBER\b/], ['Ola', /\bOLA\b|OLACABS|ANI TECHNOLOGIES/], ['Rapido', /RAPIDO|ROPPEN/],
    ['IRCTC', /IRCTC/], ['MakeMyTrip', /MAKEMYTRIP|MAKE MY TRIP/], ['Goibibo', /GOIBIBO/], ['IndiGo', /INDIGO|INTERGLOBE/], ['Airbnb', /AIRBNB/], ['Air India', /AIR ?INDIA/],
    ['Netflix', /NETFLIX/], ['Spotify', /SPOTIFY/], ['YouTube', /YOUTUBE/], ['Google Play', /GOOGLE ?PLAY/], ['Google', /GOOGLE/],
    ['Apple', /APPLE\.COM|ITUNES|APPLE SERVICES/], ['Hotstar', /HOTSTAR/], ['BookMyShow', /BOOKMYSHOW|BOOK MY SHOW/], ['PVR INOX', /\bPVR\b|INOX/],
    ['OpenAI', /OPENAI|CHATGPT/], ['Anthropic', /ANTHROPIC|CLAUDE\.AI/], ['Microsoft', /MICROSOFT|MSFT/],
    ['Airtel', /AIRTEL/], ['Jio', /\bJIO\b|RELIANCE JIO/], ['Vi', /VODAFONE|\bVI\b/], ['BESCOM', /BESCOM/],
    ['Paytm', /PAYTM/], ['PhonePe', /PHONEPE/], ['CRED', /\bCRED\b|CREDCLUB|DREAMPLUG/],
    ['Starbucks', /STARBUCKS/], ['Domino\'s', /DOMINO/], ['McDonald\'s', /MCDONALD/], ['KFC', /\bKFC\b/],
    ['Apollo Hospitals', /APOLLO (HOSPITAL|SPECTRA|CRADLE|CLINIC)/], ['Apollo Pharmacy', /APOLLO/], ['PharmEasy', /PHARMEASY/], ['Tata 1mg', /1MG/], ['cult.fit', /CULT\.?FIT|CUREFIT/],
    ['Decathlon', /DECATHLON/], ['IKEA', /IKEA/], ['Croma', /CROMA/], ['Lenskart', /LENSKART/],
    ['Indian Oil', /INDIAN OIL|\bIOCL?\b/], ['Bharat Petroleum', /BHARAT PETROLEUM|\bBPCL\b/], ['HP Petrol', /HINDUSTAN PETROLEUM|\bHPCL\b/],
  ];

  const NOISE = /\b(PVT|PRIVATE|LTD|LIMITED|LLP|INDIA|IND|IN|INC|CO|COM|WWW|HTTPS?|ONLINE|PAYMENTS?|POS|ECOM|E-COM|MUMBAI|BANGALORE|BENGALURU|BANGLORE|DELHI|NEW DELHI|GURGAON|GURUGRAM|NOIDA|HYDERABAD|CHENNAI|PUNE|KOLKATA|AHMEDABAD|SURAT|VADODARA|JAIPUR|LUCKNOW|KANPUR|INDORE|BHOPAL|NAGPUR|NASHIK|THANE|NAVI MUMBAI|CHANDIGARH|LUDHIANA|AMRITSAR|DEHRADUN|PATNA|RANCHI|BHUBANESWAR|GUWAHATI|RAIPUR|VISAKHAPATNAM|VIJAYAWADA|COIMBATORE|MADURAI|MYSORE|MYSURU|MANGALORE|MANGALURU|HUBLI|GOA|PANAJI|KOCHI|COCHIN|ERNAKULAM|TRIVANDRUM|THIRUVANANTHAPURAM|KOZHIKODE|CALICUT|THRISSUR|KANNUR|KOLLAM)\b/g;

  function cleanDesc(desc) {
    return desc.toUpperCase()
      .replace(/^(UPI[-\/ ]?|POS |ECOM |PYU\*|PAYU\*|RAZ\*|RAZORPAY\*?|PAYTM\*|CCAVENUE\*|BILLDESK\*|PG\*|SI\*|MPS\/)/, '')
      .replace(/\bREF(ERENCE)?\s*(NO\.?)?\s*[:#]?\s*\w+/g, ' ')
      .replace(/\b(USD|EUR|GBP|AED|SGD|AUD|CAD|JPY|THB|MYR|CHF)\s*[\d,]*\.?\d*/g, ' ')
      .replace(/[*#@_\/\\|:]/g, ' ')
      .replace(/\b\w*\d{4,}\w*\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function normaliseMerchant(desc) {
    const up = desc.toUpperCase();
    for (const [name, re] of BRANDS) if (re.test(up)) return name;
    let c = cleanDesc(desc).replace(NOISE, ' ').replace(/[^A-Z0-9&.' ]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = c.split(' ').filter(w => w.length > 1 || /&/.test(w));
    if (!words.length) return desc.slice(0, 24).trim();
    return words.slice(0, 3).join(' ').replace(/\b\w/g, ch => ch).replace(/\B\w+/g, w => w.toLowerCase());
  }

  function categorise(txn, overrides) {
    const merchant = normaliseMerchant(txn.description);
    if (overrides && overrides[merchant]) return { merchant, category: overrides[merchant], overridden: true };
    const up = (txn.description + ' ' + (txn.extra || '')).toUpperCase();
    if (txn.type === 'credit') {
      for (const [cat, re] of CREDIT_RULES) if (re.test(up)) return { merchant, category: cat };
      return { merchant, category: 'Refund / reversal' };
    }
    for (const [cat, re] of DEBIT_RULES) if (re.test(up)) return { merchant, category: cat };
    if (/\bUPI\b/.test(up)) return { merchant, category: 'UPI merchants' };
    return { merchant, category: 'Other' };
  }

  const PAID_RE = /PAYMENT RECEIVED|RECEIVED[\s,.-]*THANK YOU|THANK YOU FOR (YOUR )?PAYMENT|PAYMENT[\s,.-]*THANK YOU/;
  function normaliseTxn(t) {
    const up = (t.description + ' ' + (t.extra || '')).toUpperCase();
    const fix = {};
    if (t.type === 'debit' && PAID_RE.test(up)) fix.type = 'credit';
    if (t.time === '00:00') fix.time = null;
    return Object.keys(fix).length ? Object.assign({}, t, fix) : t;
  }

  let natureOverrides = {};
  function setNatures(map) { natureOverrides = map || {}; }
  function natureOf(cat) { return natureOverrides[cat] || (CATEGORIES[cat] || {}).nature; }

  window.Categoriser = { CATEGORIES, categorise, normaliseMerchant, normaliseTxn, setNatures, natureOf };
})();
