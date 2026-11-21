# Backend configuration

The checkout's Google Maps location lookup uses the Geocoding API. Set
`GOOGLE_MAPS_API_KEY` in `backend/.env` and enable the Geocoding API for that key.
The key stays on the server; location lookup is unavailable until it is configured.
The rest of the checkout address flow does not require this optional setting.
The browser location button also requires HTTPS (or localhost) and the user's permission.

Online checkout uses Razorpay. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`
in `backend/.env`, keep automatic payment capture enabled in the Razorpay account,
and use test keys until the checkout flow has been verified.
