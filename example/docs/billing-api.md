# Billing API (fixture)

This file stands in for the real documentation of the fictional billing
system. The example claims point their verify commands at it.

- amounts_in_cents: all monetary fields are integer cents.
- Cancelled invoices keep `paid_at = NULL` and carry a `cancel_id`.
