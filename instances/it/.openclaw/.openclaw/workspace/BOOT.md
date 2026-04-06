# BOOT.md — Fleet Sales Agent

On every startup, confirm proxy is reachable:
```bash
curl -s http://127.0.0.1:20000/fleet-api/retrieve -X POST -H "Content-Type: application/json" -d '{"org_id":"f86d92cb-db10-43ff-9ff2-d69c319d272d"}' > /dev/null && echo "Proxy OK"
```
