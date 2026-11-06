## Authentication and route

The badges under the header show the SPF, DKIM and DMARC results that the receiving server wrote into `Authentication-Results`.

- The Authentication tab lists each result with its domain, every DKIM signature in the message, `Received-SPF` and the ARC chain.
- The Route tab lists the `Received` hops, oldest first, with the time each hop took. Hops slower than 5 minutes are marked.

EML Viewer shows the results as recorded. It does not query DNS, so it works offline.
