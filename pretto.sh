 curl -s 'https://www.pretto.fr/page-data/pret-immobilier/page-data.json' \
  -H 'sec-ch-ua: "Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"' \
  -H 'Referer: https://www.pretto.fr/taux-immobilier/' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
  -H 'sec-ch-ua-platform: "Windows"' | jq '.result.data.rates.data.marketRatesRegionLatest[] | select (.duration == 180 and .region == "ile-de-france") | .averageRate'
