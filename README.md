# Take home project

This is an e-commerce demo application for browsing and selecting books from Stripe Press.

## Book selection

Customers can browse the catalog of three books on the home page (`/`) and select one to view its order summary on the checkout page (`/checkout?item=:id`).

- **Catalog source**: Book details and prices are served from a single server-owned catalog (`lib/catalog.js`).
- **Currency & pricing**: All amounts are defined in cents and formatted in USD (e.g., `$23.00 USD`, `$25.00 USD`, `$28.00 USD`).
- **Validation**: Selection links use exact IDs (`1`, `2`, `3`). Missing or malformed parameters return HTTP 400, while unrecognized IDs return HTTP 404 with a link back to the catalog.
- **Payment status**: Payment processing is not implemented yet. The order summary displays selected item details and an informational message that payment is not available in this demo yet.

## Running locally

Stripe API keys are **not required** to run and test book selection.

1. Clone the repository and install dependencies:

```bash
git clone https://github.com/mattmitchell6/sa-takehome-project-node && cd sa-takehome-project-node
npm install
```

2. Start the local server:

```bash
npm start
```

3. Open [http://localhost:3000](http://localhost:3000) in your browser.
