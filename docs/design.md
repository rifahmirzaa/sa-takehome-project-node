# Design

[Overview](../README.md) · [Setup](setup.md) · [Components](#components) · [Purchase](#purchase-and-confirmation) · [Recovery](#retry-and-recovery) · [Webhooks](#webhook-delivery)

## Components

One Express process serves pages and payment endpoints. Stripe operations are isolated in a helper module; the [code map](../README.md#architecture) identifies each file.

```mermaid
flowchart LR
    Buyer[Customer browser]
    UI[Handlebars pages and browser scripts]
    App[Express routes]
    Catalog[lib/catalog.js]
    Payments[lib/payments.js]
    Element[Stripe.js Payment Element]
    Stripe[Stripe API]
    Buyer --> UI
    UI --> App
    UI --> Element
    App --> Catalog
    App --> Payments
    Payments --> Stripe
    Element --> Stripe
    CLI[Stripe CLI local listener]
    Stripe -->|Sandbox events| CLI
    CLI -->|Signed webhook requests| App
```

- **Server:** owns pricing and holds the secret API key.
- **Browser:** receives the publishable key and payment client secret; session storage retains the attempt for recovery.
- **Stripe:** collects payment details and holds payment records. The app does not store card data.

## Purchase and confirmation

```mermaid
sequenceDiagram
    actor Customer
    participant Browser
    participant App as Express app
    participant Stripe as Stripe API
    Customer->>Browser: Select a book
    Browser->>App: GET /checkout?item=2
    App-->>Browser: Book summary and publishable key
    Browser->>Browser: Save attempt ID and timestamp
    Browser->>App: POST /create-payment-intent (book ID, attempt ID)
    App->>App: Look up the catalog price
    App->>Stripe: Create PaymentIntent with idempotency key
    Stripe-->>App: PaymentIntent and client secret
    App-->>Browser: Client secret
    Browser->>Browser: Mount Payment Element
    Customer->>Browser: Enter payment details and submit
    Browser->>Stripe: stripe.confirmPayment via Stripe.js
    opt Additional authentication required
        Stripe-->>Browser: Authentication challenge or redirect
        Customer->>Browser: Complete authentication
        Browser->>Stripe: Authentication response
    end
    alt Validation error or card decline
        Stripe-->>Browser: Error for customer to correct
    else Return to the app
        Stripe-->>Browser: Redirect to /success with payment reference
        Browser->>App: POST /payment-status (client secret)
        App->>Stripe: Retrieve PaymentIntent
        Stripe-->>App: Current status and amount received
        App->>App: Check secret and integration metadata
        App-->>Browser: Verified status, amount, currency, and intent ID
        alt Status is succeeded
            Browser-->>Customer: Receipt with total charged and pi_ ID
        else Processing or incomplete
            Browser-->>Customer: Current state and appropriate next action
        end
    end
```

The receipt checks the client secret and `integration` metadata against a freshly retrieved intent. A redirect alone cannot confirm payment.

### Application endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /` | Render the book catalog |
| `GET /checkout?item=:id` | Validate the selection and render checkout |
| `POST /create-payment-intent` | Accept `{ itemId, attemptId }`; use catalog pricing; return `{ clientSecret }` |
| `POST /payment-status` | Accept `{ clientSecret }`; return verified status, received amount, currency, intent ID, book ID, and attempt ID |
| `GET /success` | Render the receipt shell; the browser requests payment status |
| `POST /webhook` | Verify the signature and log relevant events |

- Status errors: **400** for malformed references, **404** for missing/mismatched records, **502** for temporary retrieval failures.
- Payment pages use `no-store`, `no-referrer`, and a Content Security Policy. Payment API responses use `no-store`.
- Client secrets grant access to a payment; do not log or share them. This is not customer account authentication.

## Retry and recovery

```mermaid
sequenceDiagram
    participant Browser
    participant Storage as Session storage
    participant App as Express app
    participant Stripe as Stripe API
    Browser->>Storage: Save attempt before first create request
    Browser->>App: Create intent for attempt A
    App->>Stripe: Create with idempotency key for A
    Stripe-->>App: Intent created
    Note over Browser,App: The response is lost before the browser receives it
    Browser->>Storage: Read attempt A on retry or reload
    Browser->>App: Retry create using attempt A
    App->>Stripe: Repeat request with the same idempotency key
    Stripe-->>App: Return the original result
    App-->>Browser: Original client secret
    Browser->>Storage: Save client secret for A
    Note over Browser,Stripe: With a known secret, resumed checkout retrieves status instead of creating
    Browser->>App: Check status of A
    App->>Stripe: Retrieve original intent
    alt Status cannot be verified
        App-->>Browser: Retrieval error
        Browser->>Storage: Preserve attempt A
        Browser->>Browser: Show retry and keep Pay disabled
    else Status verified
        Stripe-->>App: Current intent state
        App-->>Browser: Verified state
        Browser->>Browser: Resume the form or open the status page
    end
```

Creation retries reuse the attempt's idempotency key while it is under 24 hours old. Older attempts without a saved client secret stop for reconciliation; known intents remain retrievable. Clearing storage or switching devices loses the association.

| Verified state | Customer action | Stored attempt |
| --- | --- | --- |
| `succeeded` | View receipt | Clear matching attempt |
| `canceled` | Return to catalog | Clear matching attempt |
| `processing` | Check again | Preserve |
| `requires_payment_method` | Correct details and retry | Reuse |
| `requires_action` / `requires_confirmation` | Return to checkout | Reuse |
| Other state or retrieval error | Follow status message or retry check | Preserve |

Pay stays disabled until the Element is ready and while confirmation is in progress. An old receipt cannot clear a newer attempt.

## Webhook delivery

```mermaid
sequenceDiagram
    participant Stripe
    participant CLI as Stripe CLI (local development)
    participant App as POST /webhook
    participant SDK as Stripe SDK
    Stripe->>CLI: PaymentIntent event
    CLI->>App: Forward body and Stripe-Signature
    App->>SDK: constructEvent(raw body, signature, signing secret)
    alt Invalid or missing signature
        App-->>CLI: HTTP 400
    else Verified event
        SDK-->>App: Parsed event
        App->>App: Log event ID, intent ID, and status when relevant
        App-->>CLI: HTTP 200
    end
```

- The raw-body route runs before Express's JSON parser so signature verification receives the original bytes.
- Relevant events: `payment_intent.succeeded`, `payment_intent.processing`, and `payment_intent.payment_failed`.
- Other verified events receive HTTP 200. Repeated events may produce repeated logs; there are no fulfillment side effects.
- Delivery is independent of the receipt visit and can arrive before or after it.

Locally, the [launcher](setup.md#launcher) supplies the CLI listener's signing secret. In production, Stripe would send events directly to a registered HTTPS endpoint with its own secret.

Persistent orders and fulfillment are [planned extensions](../README.md#next-steps), alongside merchant tools and deployment controls.
