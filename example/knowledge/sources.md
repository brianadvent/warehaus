# Source knowledge (example)

What an agent must know about the two source systems of the fictional shop,
written as claims. Each claim carries its provenance and a command that
checks it against the source.

## Billing

<!-- claim
id: billing-amounts-in-cents
type: structure
sot: billing-api
maintenance: verified
verify_cmd: "grep -q amounts_in_cents docs/billing-api.md"
budget: free
as_of: 2026-08-31
-->
The billing API returns all monetary amounts as integer cents. Divide by 100
before displaying or adding them to figures from other systems.
<!-- /claim -->

<!-- claim
id: revenue-excludes-cancellations
type: rule
sot: adr:0001
maintenance: verified
decided_in: ADR-0001
as_of: 2026-08-31
-->
Every revenue figure excludes invoices that carry a `cancel_id`. Without this
filter, revenue and outstanding amounts are overstated.
<!-- /claim -->

## Shop

<!-- claim
id: shop-api-read-scopes
type: access
sot: shop-api
maintenance: verified
verify_cmd: "grep -q read_orders docs/shop-api.md"
budget: free
as_of: 2026-08-31
-->
The shop token is read-only: read_orders, read_customers, read_products.
Write operations fail with a scope error, not an authentication error; the
two must not be confused when debugging.
<!-- /claim -->

<!-- claim
id: product-catalog-size
type: count
sot: shop-api
maintenance: generated
verify_cmd: "grep -c \"^- SKU \" docs/catalog.md"
budget: free
tolerance: 10%
as_of: 2026-08-31
-->
The product catalog currently lists
<!--gen:product-catalog-size-->6<!--/gen--> SKUs. The number between the
markers is written by `warehaus stand`; a hand edit there shows up as drift.
<!-- /claim -->

<!-- claim
id: wholesale-consignment-timing
type: experience
sot: person:alex
maintenance: manual
source: "Alex (operations), 2026-08-01"
confirmed_on: 2026-08-01
as_of: 2026-08-01
-->
The largest wholesale partner is billed on consignment after sell-through.
An ordered quantity above the invoiced quantity is timing, not a data error
and not a billing gap.
<!-- /claim -->
