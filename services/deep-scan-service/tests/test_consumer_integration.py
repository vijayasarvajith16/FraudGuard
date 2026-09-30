"""End-to-end consumer test against a real RabbitMQ in a throwaway vhost.

Requires RABBITMQ_TEST_URL (amqp://user:pass@host:port) and RABBITMQ_TEST_MGMT_URL (http://host:port);
skipped otherwise.
"""

import asyncio
import base64
import json
import os
import urllib.request
import uuid
from urllib.parse import unquote, urlparse

import aio_pika
import pytest
from conftest import fraud_features, settings_for
from fastapi.testclient import TestClient
from test_consumer import flagged

from app.main import create_app

BASE_URL = os.environ.get("RABBITMQ_TEST_URL")
MGMT_URL = os.environ.get("RABBITMQ_TEST_MGMT_URL")
pytestmark = pytest.mark.skipif(
    not (BASE_URL and MGMT_URL), reason="RABBITMQ_TEST_URL / RABBITMQ_TEST_MGMT_URL not set"
)


def mgmt(path, method="GET", body=None):
    parsed = urlparse(BASE_URL)
    token = base64.b64encode(f"{unquote(parsed.username)}:{unquote(parsed.password)}".encode()).decode()
    req = urllib.request.Request(
        f"{MGMT_URL}/api{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Basic {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as res:
        raw = res.read()
        return json.loads(raw) if raw else None


@pytest.fixture(scope="module")
def vhost_url():
    vhost = f"fraudguard-test-{uuid.uuid4().hex[:8]}"
    mgmt(f"/vhosts/{vhost}", "PUT", {})
    user = unquote(urlparse(BASE_URL).username)
    mgmt(f"/permissions/{vhost}/{user}", "PUT", {"configure": ".*", "write": ".*", "read": ".*"})
    yield f"{BASE_URL.rstrip('/')}/{vhost}", vhost
    mgmt(f"/vhosts/{vhost}", "DELETE")


async def publish_and_collect(url, body, queue_name):
    connection = await aio_pika.connect(url)
    async with connection:
        channel = await connection.channel(publisher_confirms=True)
        exchange = await channel.get_exchange("fraudguard.events")
        await exchange.publish(
            aio_pika.Message(body, message_id=str(uuid.uuid4()), headers={"x-request-id": "it-1", "x-retry-count": 0}),
            routing_key="transaction.flagged",
            mandatory=True,
        )
        queue = await channel.get_queue(queue_name)
        try:
            async with asyncio.timeout(10), queue.iterator(no_ack=True) as messages:
                async for message in messages:
                    return message
        except TimeoutError:
            return None


def test_flagged_event_is_scored_and_published(model_dir, vhost_url):
    url, vhost = vhost_url
    with TestClient(create_app(settings_for(model_dir, CONSUMER_ENABLED="true", RABBITMQ_URL=url))) as client:
        assert client.get("/health").json()["checks"] == {"model": "ok", "rabbitmq": "ok"}

        event = flagged(fraud_features())
        message = asyncio.run(publish_and_collect(url, json.dumps(event).encode(), "transactions.scored"))
        assert message is not None, "no transaction.scored message arrived"
        scored = json.loads(message.body)
        assert scored["eventType"] == "transaction.scored"
        assert scored["payload"]["transactionId"] == event["payload"]["transactionId"]
        assert scored["payload"]["riskTier"] == "CRITICAL"
        assert message.message_id == scored["eventId"]
        assert message.correlation_id == event["payload"]["transactionId"]
        assert message.delivery_mode == aio_pika.DeliveryMode.PERSISTENT
        assert message.headers["x-request-id"] == "it-1"

        text = client.get("/metrics").text
        assert 'queue_messages_consumed_total{result="ok"} 1.0' in text

    queues = {q["name"]: q for q in mgmt(f"/queues/{vhost}")}
    assert queues["transactions.scored"]["arguments"] == {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": "fraudguard.dlx",
        "x-dead-letter-routing-key": "transaction.scored",
        "x-delivery-limit": 10,
    }
    assert queues["transactions.flagged"]["arguments"]["x-queue-type"] == "quorum"


def test_poison_message_lands_in_the_dead_letter_queue(model_dir, vhost_url):
    url, _ = vhost_url
    with TestClient(create_app(settings_for(model_dir, CONSUMER_ENABLED="true", RABBITMQ_URL=url))):
        message = asyncio.run(publish_and_collect(url, b'{"not": "an event"}', "transactions.flagged.dlq"))
    assert message is not None, "poison message was not dead-lettered"
    assert json.loads(message.body) == {"not": "an event"}
