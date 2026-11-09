import { apiUrl } from '../../common/urls'
import { ClientProof, SignupChallengeResponse, SignupFields } from '../../common/users/client-proof'
import { ClientSessionInfo } from '../../common/users/session'
import { fetchJson } from '../network/fetch'
import { isFetchError, isFetchNetworkError } from '../network/fetch-errors'

export async function createSignupSession(
  fields: SignupFields,
  collection: {
    collectProof?: (nonce: string, requestHash: string) => Promise<ClientProof>
    collectLegacyIds: () => Promise<{ clientIds: [number, string][] }>
  },
  signal?: AbortSignal,
): Promise<ClientSessionInfo> {
  signal?.throwIfAborted()
  const collectProof = collection.collectProof
  let challenge: SignupChallengeResponse = { required: false }
  if (collectProof) {
    try {
      challenge = await fetchJson<SignupChallengeResponse>(apiUrl`users/signup-challenge`, {
        method: 'post',
        body: JSON.stringify(fields),
        signal,
      })
    } catch (err) {
      if (!isFetchError(err) || err.status !== 404) throw err
    }
  }
  signal?.throwIfAborted()
  const extra =
    challenge.required && collectProof
      ? {
          attemptId: challenge.attemptId,
          proof: await collectProof(challenge.nonce, challenge.requestHash),
        }
      : await collection.collectLegacyIds()
  const body = JSON.stringify({ ...fields, ...extra })
  signal?.throwIfAborted()
  try {
    return await fetchJson<ClientSessionInfo>(apiUrl`users`, { method: 'post', body, signal })
  } catch (err) {
    // Only requests with an attempt ID can safely recover a lost account-creation response.
    if (!challenge.required || !isFetchNetworkError(err)) throw err
    signal?.throwIfAborted()
    return await fetchJson<ClientSessionInfo>(apiUrl`users`, { method: 'post', body, signal })
  }
}
