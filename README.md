# RPhone service tracker

## Run locally

Use Node.js 18 or newer. From PowerShell in this folder:

```powershell
node server.js
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The customer form, tracking page, and admin page must use this server; opening `index.html` directly will not save orders.

The admin page is available at [http://127.0.0.1:3000/admin.html](http://127.0.0.1:3000/admin.html). The local `.env` file sets `ADMIN_PASSWORD`; it is excluded from version control. An `ADMIN_PASSWORD` environment variable overrides the local file. The default bind address is `127.0.0.1`, so the service is only reachable from the same computer.

Orders and price settings are stored in `data/orders.json`. Keep this file private and back it up. Set `RPHONE_DATA_FILE` to use a different file location.

## Customer tracking

Customers can search using the exact full name or complete WhatsApp number submitted with the form. Search results show order IDs, device/LCD details, current status, and progress history; they do not return the customer's name or phone number.

The customer form also accepts battery, housing, charging-port, camera, speaker/microphone, button, software, and other service requests. Admins can set a price range for each service. Leave both range fields blank until a price is known; those orders will show that an estimate is pending inspection.

## Hosting

This local setup is not a public production deployment. To accept orders from customers on other networks, deploy the Node.js server behind HTTPS and configure a persistent private data store. Set `NODE_ENV=production` when HTTPS is terminated by the hosting platform so admin session cookies use the `Secure` attribute. Do not expose the data file or commit it to a public repository.
