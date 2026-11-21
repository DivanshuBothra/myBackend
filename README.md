# Backend configuration

The checkout's Google Maps location lookup uses the Geocoding API. Set
`GOOGLE_MAPS_API_KEY` in `backend/.env` and enable the Geocoding API for that key.
The key stays on the server; location lookup is unavailable until it is configured.
The rest of the checkout address flow does not require this optional setting.
The browser location button also requires HTTPS (or localhost) and the user's permission.

Online checkout uses Razorpay. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`
in `backend/.env`, keep automatic payment capture enabled in the Razorpay account,
and use test keys until the checkout flow has been verified.

Orders receive a unique server-generated order number and are stored with the
user ID, item quantities, payment timing, amount, and status history. Admins
advance delivery tracking from confirmed to processing, shipped, and delivered.
Customers can cancel within 48 hours before shipment. Prepaid cancellations are
marked refund-pending; process the refund in Razorpay before marking it processed
in the admin Orders screen. Only safe payment metadata (method, card network,
and last four digits) is stored; never store full card numbers, CVV, or bank
credentials.
