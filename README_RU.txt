BOBLOX SERVER — kak zapustit'
=============================

LOKAL'NO (dlya testa):
1. Ustanovi Node.js (https://nodejs.org, versiya 18+).
2. Otkroy terminal v papke Server i vypolni:
     npm install
     npm start
3. Server podnimetsya na http://localhost:3000
   - Sayt skachivaniya:  http://localhost:3000
   - Stranitsa pokupki:  http://localhost:3000/buy
4. V igre na ekrane vhoda v pole "Server" ostav' http://localhost:3000
   (dlya telefona v toy zhe Wi-Fi seti ukazhi http://IP-tvoego-PC:3000).

V INTERNET (besplatno, Render.com):
1. Zagruzi papku Server v GitHub-repozitoriy.
2. Na render.com sozdai "Web Service" iz etogo repozitoriya:
     Build command: npm install
     Start command: npm start
3. Poluchish adres vida https://boblox.onrender.com — vvedi ego v igre
   v pole "Server" na ekrane vhoda.
4. Builds (Boblox_Windows.zip i Boblox_Android.apk) polozhi v
   Server/public/downloads PERED zagruzkoy v GitHub.

CHTO UMEET SERVER:
- /api/register, /api/login  — akkaunty (parol' hranitsya kak hash s sol'yu)
- /api/balance, /api/grant, /api/spend — servernyi balans BobCoins
- /api/purchase, /api/inventory — pokupki predmetov s proverkoy tseny NA SERVERE
- /buy — TESTOVAYA stranitsa pokupki monet (den'gi NE spisyvayutsya)
- /    — sayt so ssylkami na skachivanie Windows ZIP i Android APK

VAZHNO PRO REAL'NYE DEN'GI:
Seychas /buy — eto zaglushka dlya testov. Dlya nastoyashchikh platezhey nuzhno
podklyuchit' provaydera (Stripe / YooKassa / i t.p.) vnutri obrabotchika
/api/devbuy v boblox-server.js. Ostal'noy kod menyat' ne nado.

BAZA DANNYKH:
Fayl boblox-db.json ryadom s serverom. Udalish' fayl — udalish' vse akkaunty.
