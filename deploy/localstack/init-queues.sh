#!/bin/sh
set -e

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# --attributes shorthand não lida bem com o valor JSON aninhado de
# RedrivePolicy (o parser espera "chave=valor" e se perde no "{" do JSON) —
# usar um arquivo de atributos em JSON completo evita a ambiguidade de escape.
cat > /tmp/wager-transactions-attrs.json <<EOF
{
  "FifoQueue": "true",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"
}
EOF

awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes file:///tmp/wager-transactions-attrs.json

awslocal sqs create-queue --queue-name wagering-events.fifo --attributes FifoQueue=true

echo "Filas SQS provisionadas: wager-transactions.fifo, wager-transactions-dlq.fifo, wagering-events.fifo"
