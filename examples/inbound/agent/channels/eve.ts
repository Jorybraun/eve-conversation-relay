import { eveChannel } from "eve/channels/eve";

// The public tunnel must not expose Eve's local-dev session APIs. Only the
// signature-verified phone channel accepts conversation input in this example.
export default eveChannel({ auth: [] });
