// Worker entry. Only the default handler is exported here (workerd treats every named export as
// a handler); the logic lives in ./mcp.
import { handle, type Env } from "./mcp"

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env)
  },
}
