# Log tester

Test sending logs to the API log-stream.

This is only meant to be used for debugging purposes. Abusing the tool may result in API limits being enforced.

## Usage

```
# Install dependencies
$ npm i

# Set the credentials as env vars (required)
$ export UUID=<my-device-uuid>
$ export API_KEY=<device-api-key>

# Start logging. Logs should show on the dashboard and on
# stdout
$ npm run dev
Mon, 27 Feb 2023 21:16:44 GMT - Test message No. 0. Next message in 1(s)
Mon, 27 Feb 2023 21:16:45 GMT - Test message No. 1. Next message in 2(s)
Mon, 27 Feb 2023 21:16:47 GMT - Test message No. 2. Next message in 3(s)
Mon, 27 Feb 2023 21:16:50 GMT - Test message No. 3. Next message in 4(s)
Mon, 27 Feb 2023 21:16:54 GMT - Test message No. 4. Next message in 5(s)
```

On a balena device

```
balena run --rm -ti -e UUID=$(cat /mnt/boot/config.json | jq -r .uuid) -e API_KEY=$(cat /mnt/boot/config.json | jq -r .deviceApiKey) gh.cr/balena-os/log-streamer
```
