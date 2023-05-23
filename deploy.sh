set -e

. ./.env

ask() {
    local prompt default reply

    if [[ ${2:-} = 'Y' ]]; then
        prompt='Y/n'
        default='Y'
    elif [[ ${2:-} = 'N' ]]; then
        prompt='y/N'
        default='N'
    else
        prompt='y/n'
        default=''
    fi

    while true; do

        # Ask the question (not using "read -p" as it uses stderr not stdout)
        echo -n "$1 [$prompt] "

        # Read the answer (use /dev/tty in case stdin is redirected from somewhere else)
        read -r reply </dev/tty

        # Default?
        if [[ -z $reply ]]; then
            reply=$default
        fi

        # Check if the reply is valid
        case "$reply" in
            Y*|y*) return 0 ;;
            N*|n*) return 1 ;;
        esac

    done
}

export SERVER=$SERVER

# To avoid problems when deploying dhcpd-dns ...
IP=$(python3 -c "import socket; print(socket.gethostbyname('$SERVER'))")

HOST=$IP
APP=metrics-collector

echo "deploying on $SERVER through $HOST"

ssh -t $HOST "cd $APP ; sudo docker compose down" || (ask 'Continue ?' || exit)

rsync -avb --backup-dir=/tmp --exclude .git --exclude node_modules . $HOST:$APP

if ask 'Do build ?' N; then
    ssh -t $HOST "cd $APP ; sudo docker compose up -d --build"
else
    ssh -t $HOST "cd $APP ; sudo docker compose up -d"
fi

ssh -t $HOST "cd $APP ; sudo docker compose logs -f -t"

