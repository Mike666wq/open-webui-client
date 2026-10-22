"""One-time authorized repository-secret transfer. Never log secret values or API bodies."""
import base64
import json
import os
import urllib.error
import urllib.request
from nacl.public import PublicKey, SealedBox

DESTINATION = 'Mike666wq/open-webui-frontend'
NAMES = ('ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD')


def main():
    token = os.environ.get('MIGRATION_TOKEN', '')
    values = {name: os.environ.get(name, '') for name in NAMES}
    if not token or not all(values.values()):
        raise RuntimeError('Required migration token or original signing secrets are missing')
    def api(route, body=None):
        request = urllib.request.Request(
            'https://api.github.com/repos/' + DESTINATION + '/actions/secrets/' + route,
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'},
            data=json.dumps(body).encode() if body is not None else None,
            method='PUT' if body is not None else 'GET')
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response) if response.status == 200 else None
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'Destination secret API returned HTTP {error.code}; check token repository and Secrets write permission') from None
    key = api('public-key')
    box = SealedBox(PublicKey(base64.b64decode(key['key'])))
    for name, value in values.items():
        api(name, {'key_id': key['key_id'], 'encrypted_value': base64.b64encode(box.encrypt(value.encode())).decode()})
    for name in NAMES:
        if api(name).get('name') != name:
            raise RuntimeError('Destination secret metadata verification failed')
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as out:
        out.write('Original Android signing secrets copied to frontend using its public encryption key. No new signing key was generated. Remove the temporary migration token and revoke it after frontend signing validation.\n')
    print('Both original signing secrets transferred and destination metadata verified.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No traceback or API response body can accidentally reveal credentials.
        print(str(error) if isinstance(error, RuntimeError) else 'Signing migration failed; secret values were not logged.')
        raise SystemExit(1)
